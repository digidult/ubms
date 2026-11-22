//! Bluetooth Low Energy bridge on top of bluest (Windows, macOS, Linux).
//!
//! Commands and events follow `docs/tauri.md`. The rules that shape this module:
//!
//! - Several characteristics may share one UUID in one service (new JK BMS modules have a
//!   write-only FFE1 and a notify FFE1). bluest keeps one object per native characteristic, so the
//!   bridge picks the object by service, UUID and properties once, the same way
//!   `packages/transport/src/web-bluetooth.js` does, and never resolves by UUID again.
//! - Device ids are the Display form of `DeviceId` (stable across runs) and are parsed back with
//!   serde, so a remembered device opens without a scan.
//! - Every way a connect can end (success, error, timeout, cancel by `ble_disconnect`) releases
//!   what it opened; every connection has a generation, so a stale task never removes a newer one.
//! - The state mutex is never held across an `.await`: commands clone the bluest objects they
//!   need, so different devices never wait for each other.
//! - Linux scans through bluer directly (the bluest Linux scan has no RSSI and lists devices
//!   BlueZ only remembers); macOS reads the permission state through CoreBluetooth.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use bluest::error::ErrorKind;
use bluest::{
    Adapter, AdapterEvent, Characteristic, CharacteristicProperties, ConnectionEvent, Device, DeviceId, Uuid,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, OnceCell};
use tokio::time::timeout;

use crate::err;

/// Default connect timeout; the web app passes its own.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(20_000);
/// Upper bound for one disconnect while cleaning up.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(3);
/// Upper bound for enabling notifications (CCCD write).
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Upper bound for one GATT write.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Default scan duration; the web app passes its own.
const SCAN_TIMEOUT: Duration = Duration::from_millis(15_000);
/// Upper bound for a scan to report that it started.
const SCAN_START_TIMEOUT: Duration = Duration::from_secs(5);
/// A device that changes only its RSSI is reported at most this often.
const RSSI_INTERVAL: Duration = Duration::from_secs(1);
/// Fallback when a platform has no connection events for a device.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// macOS reports the adapter as unavailable for a moment after it was created (state Unknown).
#[cfg(target_os = "macos")]
const SETTLE: Duration = Duration::from_millis(1500);
#[cfg(not(target_os = "macos"))]
const SETTLE: Duration = Duration::ZERO;

// Texts the web app shows. Where the meaning matches, they equal the web app's own strings, so
// the existing translations apply.
// Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
const NOT_CONNECTED: &str = "Bluetooth device is not connected";
const NOT_FOUND: &str = "Device not found, scan again";
const TIMED_OUT: &str = "Bluetooth connection timed out";
const CANCELLED: &str = "Connection cancelled";

/// Bluetooth state managed by Tauri.
#[derive(Default)]
pub struct BleState {
    /// Created once and cloned: on macOS every adapter is its own CBCentralManager, and a
    /// connection made through one cannot be used through another.
    adapter: OnceCell<Adapter>,
    /// The bluer adapter of the Linux scan shim (it keeps its own D-Bus session alive).
    #[cfg(target_os = "linux")]
    bluez: OnceCell<bluer::Adapter>,
    /// Never held across an await.
    inner: Mutex<Inner>,
    /// Serializes scan start and stop.
    scan_gate: tokio::sync::Mutex<()>,
    /// Numbers connections, see `lost`.
    generation: AtomicU64,
}

#[derive(Default)]
struct Inner {
    scan: Option<JoinHandle<()>>,
    connections: HashMap<String, Connection>,
    /// Connects in progress; dropping or firing `cancel` ends one.
    pending: HashMap<String, Pending>,
    /// Per device id: serializes connect and disconnect.
    gates: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

struct Pending {
    generation: u64,
    cancel: oneshot::Sender<()>,
}

/// Everything bluest gave us for one connection. Windows closes the link only when the device
/// and every object obtained from it are dropped, so they live here together and go together.
struct Connection {
    generation: u64,
    device: Device,
    /// One entry per native characteristic, duplicates included, in discovery order; `chars`
    /// holds the bluest object with the same index.
    metas: Vec<CharMeta>,
    chars: Vec<Characteristic>,
    services: Vec<ServiceInfo>,
    watcher: Option<JoinHandle<()>>,
    /// Notification pumps by characteristic index (one notify stream per characteristic).
    pumps: HashMap<usize, JoinHandle<()>>,
    /// Serializes subscribe and unsubscribe of this connection.
    notify_gate: Arc<tokio::sync::Mutex<()>>,
}

impl Connection {
    /// Stops the watcher and the pumps (dropping a notify stream turns notifications off) and
    /// drops every bluest object of this connection.
    async fn shutdown(mut self) {
        if let Some(watcher) = self.watcher.take() {
            watcher.abort();
            let _ = watcher.await;
        }
        let pumps: Vec<JoinHandle<()>> = self.pumps.drain().map(|(_, pump)| pump).collect();
        for pump in pumps {
            pump.abort();
            let _ = pump.await;
        }
    }
}

impl BleState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn gate(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut inner = self.lock();
        let gate = inner.gates.entry(id.to_string()).or_default().clone();
        gate
    }

    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// The system adapter, created on first use (a failed attempt is retried on the next call,
    /// so an adapter plugged in later is found). Also starts the `ble://adapter` monitor.
    async fn adapter(&self, app: &AppHandle) -> bluest::Result<Adapter> {
        let app = app.clone();
        let adapter = self
            .adapter
            .get_or_try_init(move || async move {
                let adapter = Adapter::default().await?;
                spawn_adapter_monitor(app, adapter.clone());
                Ok::<Adapter, bluest::Error>(adapter)
            })
            .await?;
        Ok(adapter.clone())
    }
}

#[cfg(target_os = "linux")]
impl BleState {
    async fn bluez(&self) -> Result<bluer::Adapter, String> {
        let adapter = self
            .bluez
            .get_or_try_init(|| async {
                // The adapter keeps the session's D-Bus connection alive.
                let session = bluer::Session::new().await?;
                let adapter = session.default_adapter().await?;
                Ok::<bluer::Adapter, bluer::Error>(adapter)
            })
            .await
            .map_err(err)?;
        Ok(adapter.clone())
    }
}

// ---------------------------------------------------------------------------------------------
// Payloads

/// Result of `ble_adapter_state` and payload of `ble://adapter`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AdapterStatus {
    /// "on", "off", "unauthorized", "unavailable" or "unknown".
    state: &'static str,
    /// Code for the text the web app shows ("no-adapter", "powered-off", "permission-denied",
    /// "permission-restricted", "permission-pending", "permission-unknown", "error"); null when on.
    reason: Option<&'static str>,
    /// The system's error text, if there is one.
    detail: Option<String>,
}

impl AdapterStatus {
    fn on() -> Self {
        Self { state: "on", reason: None, detail: None }
    }

    fn new(state: &'static str, reason: &'static str, detail: Option<String>) -> Self {
        Self { state, reason: Some(reason), detail }
    }

    fn is_on(&self) -> bool {
        self.state == "on"
    }

    /// Error text for a command that needs Bluetooth now (the Connect screen's texts).
    fn error_text(&self) -> String {
        let text = match self.reason {
            Some("no-adapter") | Some("powered-off") => "Bluetooth is switched off or no Bluetooth adapter was found.",
            Some("permission-denied") => "The app is not allowed to use Bluetooth. Allow it in the system settings.",
            Some("permission-restricted") => {
                "Bluetooth use is restricted on this computer, for example by a device management profile."
            }
            Some("permission-pending") => "The app is waiting for permission to use Bluetooth. Answer the system prompt.",
            Some("permission-unknown") => {
                "The Bluetooth permission state is unknown. Check the Bluetooth permission in the system settings."
            }
            _ => return self.detail.clone().unwrap_or_else(|| "Bluetooth is not available.".to_string()),
        };
        text.to_string()
    }
}

/// Scan filters sent by the web app; a device matches when any filter matches,
/// and every device matches when all lists are empty.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanFilters {
    name_prefixes: Vec<String>,
    services: Vec<String>,
    manufacturer_ids: Vec<u16>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FoundDevice {
    id: String,
    name: String,
    rssi: Option<i16>,
    services: Vec<String>,
    manufacturer_data: HashMap<u16, Vec<u8>>,
}

#[derive(Serialize, Clone)]
struct Disconnected {
    id: String,
}

#[derive(Serialize, Clone)]
struct Notification {
    id: String,
    service: String,
    characteristic: String,
    data: Vec<u8>,
}

/// A GATT service with its characteristics, as returned to the web app. Every native
/// characteristic is listed, so a JK module shows two FFE1 entries with different properties.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    uuid: String,
    characteristics: Vec<CharacteristicInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct CharacteristicInfo {
    uuid: String,
    properties: Properties,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Properties {
    read: bool,
    write: bool,
    write_without_response: bool,
    notify: bool,
    indicate: bool,
}

impl Properties {
    fn from_bluest(p: &CharacteristicProperties) -> Self {
        Self {
            read: p.read,
            write: p.write,
            write_without_response: p.write_without_response,
            notify: p.notify,
            indicate: p.indicate,
        }
    }
}

/// What the bridge knows about one native characteristic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CharMeta {
    /// Index of the service object in discovery order (a device may repeat a service UUID).
    service_index: usize,
    service: Uuid,
    uuid: Uuid,
    props: Properties,
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

/// Stable id string for the web app: the WinRT device id on Windows
/// ("BluetoothLE#BluetoothLE<adapter>-<device>"), the peripheral UUID on macOS and the address
/// ("AA:BB:CC:DD:EE:FF") on Linux, where the scan shim prints the same form directly.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn device_key(id: &DeviceId) -> String {
    id.to_string()
}

/// Inverse of `device_key`. Ids remembered by older builds (another format) give None.
#[cfg(target_os = "windows")]
fn parse_device_id(key: &str) -> Option<DeviceId> {
    if key.is_empty() {
        return None;
    }
    // serde (bluest feature "serde") encodes the OsString inside DeviceId as
    // {"Windows": [UTF-16 code units]}.
    let wide: Vec<u16> = key.encode_utf16().collect();
    serde_json::from_value(serde_json::json!({ "Windows": wide })).ok()
}

/// Inverse of `device_key`: a Uuid on macOS and a bluer::Address on Linux, both deserialized
/// from their string form. Ids remembered by older builds (another format) give None.
#[cfg(not(target_os = "windows"))]
fn parse_device_id(key: &str) -> Option<DeviceId> {
    serde_json::from_value(serde_json::Value::String(key.to_owned())).ok()
}

fn parse_uuid(text: &str) -> Result<Uuid, String> {
    Uuid::parse_str(text).map_err(|_| format!("Invalid UUID {text}"))
}

fn missing(service: Uuid, uuid: Uuid) -> String {
    format!("Characteristic {uuid} not found in service {service}")
}

/// A timeout from JavaScript in milliseconds, with a default and limits.
fn duration_ms(value: Option<u64>, default: Duration, min: Duration, max: Duration) -> Duration {
    value.map(Duration::from_millis).unwrap_or(default).clamp(min, max)
}

/// The characteristic with this UUID in the first service with this UUID that has a wanted
/// property, else the first one with the UUID. Same rule as the Web Bluetooth transport
/// (`getPrimaryService`, then `getCharacteristics` and a choice by properties).
fn pick(metas: &[CharMeta], service: Uuid, uuid: Uuid, want: fn(&Properties) -> bool) -> Option<usize> {
    let instance = metas.iter().find(|m| m.service == service)?.service_index;
    let mut first = None;
    for (index, meta) in metas.iter().enumerate() {
        if meta.service_index == instance && meta.uuid == uuid {
            if want(&meta.props) {
                return Some(index);
            }
            first.get_or_insert(index);
        }
    }
    first
}

fn can_notify(p: &Properties) -> bool {
    p.notify || p.indicate
}

fn can_write(p: &Properties) -> bool {
    p.write || p.write_without_response
}

/// Whether a write uses a write request (with response). The web app asks for a mode; a
/// characteristic that supports only the other one gets that one.
fn use_write_request(requested: bool, p: &Properties) -> bool {
    match (requested, p.write, p.write_without_response) {
        (true, true, _) => true,
        (_, _, true) => false,
        _ => true,
    }
}

fn matches(
    filters: &ScanFilters,
    wanted: &[Uuid],
    name: &str,
    advertised: &[Uuid],
    manufacturer: &HashMap<u16, Vec<u8>>,
) -> bool {
    if filters.name_prefixes.is_empty() && wanted.is_empty() && filters.manufacturer_ids.is_empty() {
        return true;
    }
    filters.name_prefixes.iter().any(|p| name.starts_with(p.as_str()))
        || wanted.iter().any(|s| advertised.contains(s))
        || filters.manufacturer_ids.iter().any(|m| manufacturer.contains_key(m))
}

struct Seen {
    found: FoundDevice,
    uuids: Vec<Uuid>,
    emitted: Option<Instant>,
}

/// Merges advertisements per device (an advertisement and its scan response arrive separately,
/// Windows reports every packet) and decides what is sent to the web app: a device when it is
/// new or something other than its RSSI changed, otherwise at most once per `RSSI_INTERVAL`.
struct ScanMerger {
    filters: ScanFilters,
    wanted: Vec<Uuid>,
    seen: HashMap<String, Seen>,
}

impl ScanMerger {
    fn new(filters: ScanFilters) -> Self {
        let wanted = filters.services.iter().filter_map(|s| Uuid::parse_str(s).ok()).collect();
        Self { filters, wanted, seen: HashMap::new() }
    }

    #[cfg_attr(target_os = "linux", allow(dead_code))]
    fn has_name(&self, id: &str) -> bool {
        self.seen.get(id).is_some_and(|s| !s.found.name.is_empty())
    }

    fn update(
        &mut self,
        id: &str,
        name: Option<String>,
        rssi: Option<i16>,
        services: &[Uuid],
        manufacturer: &HashMap<u16, Vec<u8>>,
        now: Instant,
    ) -> Option<FoundDevice> {
        let entry = self.seen.entry(id.to_string()).or_insert_with(|| Seen {
            found: FoundDevice {
                id: id.to_string(),
                name: String::new(),
                rssi: None,
                services: Vec::new(),
                manufacturer_data: HashMap::new(),
            },
            uuids: Vec::new(),
            emitted: None,
        });
        let mut changed = false;
        if let Some(name) = name {
            if !name.is_empty() && name != entry.found.name {
                entry.found.name = name;
                changed = true;
            }
        }
        for service in services {
            if !entry.uuids.contains(service) {
                entry.uuids.push(*service);
                entry.found.services.push(service.to_string());
                changed = true;
            }
        }
        for (company, data) in manufacturer {
            if entry.found.manufacturer_data.get(company) != Some(data) {
                entry.found.manufacturer_data.insert(*company, data.clone());
                changed = true;
            }
        }
        if rssi.is_some() {
            entry.found.rssi = rssi;
        }
        if !matches(&self.filters, &self.wanted, &entry.found.name, &entry.uuids, &entry.found.manufacturer_data) {
            return None;
        }
        let due = match entry.emitted {
            None => true,
            Some(at) => changed || now.saturating_duration_since(at) >= RSSI_INTERVAL,
        };
        if !due {
            return None;
        }
        entry.emitted = Some(now);
        Some(entry.found.clone())
    }
}

/// State after `Adapter::default()` failed.
fn init_error_status(kind: ErrorKind, detail: String) -> AdapterStatus {
    // Windows reports a missing adapter as an error of BluetoothAdapter::GetDefaultAsync.
    let no_adapter =
        cfg!(target_os = "windows") || matches!(kind, ErrorKind::NotFound | ErrorKind::AdapterUnavailable);
    AdapterStatus::new("unavailable", if no_adapter { "no-adapter" } else { "error" }, Some(detail))
}

/// State after `Adapter::is_available()` failed.
fn query_error_status(kind: ErrorKind, detail: String) -> AdapterStatus {
    if matches!(kind, ErrorKind::NotAuthorized) {
        AdapterStatus::new("unauthorized", "permission-denied", Some(detail))
    } else {
        AdapterStatus::new("unavailable", "error", Some(detail))
    }
}

// ---------------------------------------------------------------------------------------------
// Adapter state

/// The state of an adapter that is not available: on macOS the permission decides first.
#[cfg(target_os = "macos")]
fn off_status() -> AdapterStatus {
    mac_permission().unwrap_or_else(|| AdapterStatus::new("off", "powered-off", None))
}

#[cfg(not(target_os = "macos"))]
fn off_status() -> AdapterStatus {
    AdapterStatus::new("off", "powered-off", None)
}

/// bluest reports every CoreBluetooth state other than PoweredOn as "not available"; the
/// permission tells the user what to do.
#[cfg(target_os = "macos")]
fn mac_permission() -> Option<AdapterStatus> {
    use objc2_core_bluetooth::{CBManager, CBManagerAuthorization};
    // +[CBManager authorization] (macOS 10.15, the bundle minimum). The same call bluest makes
    // when it creates the adapter; unsafe in some objc2-core-bluetooth 0.3 releases.
    #[allow(unused_unsafe)]
    let authorization = unsafe { CBManager::authorization_class() };
    match authorization {
        CBManagerAuthorization::AllowedAlways => None,
        CBManagerAuthorization::Denied => Some(AdapterStatus::new("unauthorized", "permission-denied", None)),
        CBManagerAuthorization::Restricted => Some(AdapterStatus::new("unauthorized", "permission-restricted", None)),
        CBManagerAuthorization::NotDetermined => Some(AdapterStatus::new("unknown", "permission-pending", None)),
        _ => Some(AdapterStatus::new("unknown", "permission-unknown", None)),
    }
}

/// Current adapter state, and the adapter when one exists.
async fn adapter_status(app: &AppHandle, state: &BleState) -> (AdapterStatus, Option<Adapter>) {
    let adapter = match state.adapter(app).await {
        Ok(adapter) => adapter,
        Err(e) => return (init_error_status(e.kind(), e.to_string()), None),
    };
    let status = match adapter.is_available().await {
        Ok(true) => AdapterStatus::on(),
        Err(e) => query_error_status(e.kind(), e.to_string()),
        Ok(false) if SETTLE.is_zero() => off_status(),
        Ok(false) => {
            let _ = timeout(SETTLE, adapter.wait_available()).await;
            match adapter.is_available().await {
                Ok(true) => AdapterStatus::on(),
                _ => off_status(),
            }
        }
    };
    (status, Some(adapter))
}

/// The adapter when Bluetooth can be used now, otherwise the text for the user.
async fn ready_adapter(app: &AppHandle, state: &BleState) -> Result<Adapter, String> {
    match adapter_status(app, state).await {
        (status, Some(adapter)) if status.is_on() => Ok(adapter),
        (status, _) => Err(status.error_text()),
    }
}

/// Forwards adapter changes as `ble://adapter` events.
fn spawn_adapter_monitor(app: AppHandle, adapter: Adapter) {
    tauri::async_runtime::spawn(async move {
        let mut events = match adapter.events().await {
            Ok(events) => events,
            Err(_) => return,
        };
        while let Some(event) = events.next().await {
            let status = match event {
                Ok(AdapterEvent::Available) => AdapterStatus::on(),
                Ok(_) => off_status(),
                Err(e) => AdapterStatus::new("unavailable", "error", Some(e.to_string())),
            };
            let _ = app.emit("ble://adapter", status);
        }
    });
}

#[tauri::command]
pub async fn ble_adapter_state(app: AppHandle, state: State<'_, BleState>) -> Result<AdapterStatus, String> {
    let (status, _) = adapter_status(&app, &state).await;
    Ok(status)
}

// ---------------------------------------------------------------------------------------------
// Scan

#[tauri::command]
pub async fn ble_scan_start(
    app: AppHandle,
    state: State<'_, BleState>,
    filters: Option<ScanFilters>,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let _turn = state.scan_gate.lock().await;
    // Stop the previous scan first (macOS refuses a second one, Linux and Windows would merge).
    stop_scan(&state).await;
    let adapter = ready_adapter(&app, &state).await?;
    let limit = duration_ms(timeout_ms, SCAN_TIMEOUT, Duration::from_secs(1), Duration::from_secs(300));
    let merger = ScanMerger::new(filters.unwrap_or_default());
    let (started_tx, started_rx) = oneshot::channel::<Result<(), String>>();
    let task = tauri::async_runtime::spawn(scan_task(app.clone(), adapter, merger, limit, started_tx));
    {
        let mut inner = state.lock();
        inner.scan = Some(task);
    }
    let outcome = match timeout(SCAN_START_TIMEOUT, started_rx).await {
        Ok(Ok(result)) => result,
        // Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
        Ok(Err(_)) => Err("The Bluetooth scan stopped".to_string()),
        Err(_) => Err("The Bluetooth scan did not start".to_string()),
    };
    if outcome.is_err() {
        stop_scan(&state).await;
    }
    outcome
}

#[tauri::command]
pub async fn ble_scan_stop(state: State<'_, BleState>) -> Result<(), String> {
    let _turn = state.scan_gate.lock().await;
    stop_scan(&state).await;
    Ok(())
}

/// Ends the scan task and waits until its stream is dropped (which stops the system scan).
async fn stop_scan(state: &BleState) {
    let task = {
        let mut inner = state.lock();
        inner.scan.take()
    };
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

#[cfg(not(target_os = "linux"))]
async fn scan_task(
    app: AppHandle,
    adapter: Adapter,
    mut merger: ScanMerger,
    limit: Duration,
    started: oneshot::Sender<Result<(), String>>,
) {
    // No service filter: the web app's filters are an OR of names, services and manufacturers.
    let mut stream = match adapter.scan(&[]).await {
        Ok(stream) => stream,
        Err(e) => {
            let _ = started.send(Err(e.to_string()));
            return;
        }
    };
    let _ = started.send(Ok(()));
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    let mut asked: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        let advertisement = tokio::select! {
            _ = &mut deadline => break,
            item = stream.next() => match item {
                Some(advertisement) => advertisement,
                None => break,
            },
        };
        let id = device_key(&advertisement.device.id());
        let mut name = advertisement.adv_data.local_name.clone().filter(|n| !n.is_empty());
        if name.is_none() && !merger.has_name(&id) && asked.insert(id.clone()) {
            // Neither packet carried a name so far: ask the system once per device.
            name = advertisement.device.name_async().await.ok().filter(|n| !n.is_empty());
        }
        let mut manufacturer = HashMap::new();
        if let Some(data) = &advertisement.adv_data.manufacturer_data {
            manufacturer.insert(data.company_id, data.data.clone());
        }
        let found = merger.update(
            &id,
            name,
            advertisement.rssi,
            &advertisement.adv_data.services,
            &manufacturer,
            Instant::now(),
        );
        if let Some(found) = found {
            let _ = app.emit("ble://device", found);
        }
    }
}

/// The LE discovery filter of the Linux shim.
#[cfg(target_os = "linux")]
fn le_filter() -> bluer::DiscoveryFilter {
    bluer::DiscoveryFilter { transport: bluer::DiscoveryTransport::Le, ..Default::default() }
}

/// Linux: scan through bluer. The bluest Linux scan reports no RSSI, lists devices BlueZ only
/// remembers and never updates; bluer reports every property change.
#[cfg(target_os = "linux")]
async fn scan_task(
    app: AppHandle,
    _adapter: Adapter,
    mut merger: ScanMerger,
    limit: Duration,
    started: oneshot::Sender<Result<(), String>>,
) {
    let bz = match app.state::<BleState>().bluez().await {
        Ok(bz) => bz,
        Err(e) => {
            let _ = started.send(Err(e));
            return;
        }
    };
    // Fails only while this session already discovers (DiscoveryActive); the filter then stays.
    let _ = bz.set_discovery_filter(le_filter()).await;
    let events = match bz.discover_devices_with_changes().await {
        Ok(events) => events,
        Err(e) => {
            let _ = started.send(Err(e.to_string()));
            return;
        }
    };
    let _ = started.send(Ok(()));
    let mut events = Box::pin(events);
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    loop {
        let event = tokio::select! {
            _ = &mut deadline => break,
            item = events.next() => match item {
                Some(event) => event,
                None => break,
            },
        };
        let bluer::AdapterEvent::DeviceAdded(address) = event else { continue };
        let Ok(device) = bz.device(address) else { continue };
        // BlueZ also lists cached devices that do not advertise now: they have no RSSI.
        let Ok(Some(rssi)) = device.rssi().await else { continue };
        let name = device.name().await.ok().flatten();
        let services: Vec<Uuid> =
            device.uuids().await.ok().flatten().map(|set| set.into_iter().collect()).unwrap_or_default();
        let manufacturer = device.manufacturer_data().await.ok().flatten().unwrap_or_default();
        let found = merger.update(&address.to_string(), name, Some(rssi), &services, &manufacturer, Instant::now());
        if let Some(found) = found {
            let _ = app.emit("ble://device", found);
        }
    }
}

/// Linux: BlueZ removes device objects it has not seen for a while, and connecting to such a
/// device fails with NotFound. Discover until the device advertises again (or `limit` passes).
#[cfg(target_os = "linux")]
async fn linux_wait_for(app: &AppHandle, id: &str, limit: Duration) {
    let Ok(address) = id.parse::<bluer::Address>() else { return };
    let bz = match app.state::<BleState>().bluez().await {
        Ok(bz) => bz,
        Err(_) => return,
    };
    let _ = bz.set_discovery_filter(le_filter()).await;
    let Ok(events) = bz.discover_devices_with_changes().await else { return };
    let mut events = Box::pin(events);
    let _ = timeout(limit, async {
        while let Some(event) = events.next().await {
            if let bluer::AdapterEvent::DeviceAdded(found) = event {
                if found == address {
                    if let Ok(device) = bz.device(found) {
                        if matches!(device.rssi().await, Ok(Some(_))) {
                            break;
                        }
                    }
                }
            }
        }
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// Connect and disconnect

#[tauri::command]
pub async fn ble_connect(
    app: AppHandle,
    state: State<'_, BleState>,
    id: String,
    timeout_ms: Option<u64>,
) -> Result<Vec<ServiceInfo>, String> {
    let gate = state.gate(&id);
    let _turn = gate.lock().await;
    let adapter = ready_adapter(&app, &state).await?;
    let existing = {
        let inner = state.lock();
        inner.connections.get(&id).map(|c| (c.device.clone(), c.services.clone()))
    };
    if let Some((device, services)) = existing {
        if device.is_connected().await {
            return Ok(services);
        }
        // The watcher has not seen the disconnect yet: release the stale entry first.
        let stale = {
            let mut inner = state.lock();
            inner.connections.remove(&id)
        };
        if let Some(stale) = stale {
            stale.shutdown().await;
        }
        release(&adapter, &device).await;
    }
    let generation = state.next_generation();
    let limit = duration_ms(timeout_ms, CONNECT_TIMEOUT, Duration::from_secs(1), Duration::from_secs(120));
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = oneshot::channel::<Result<Vec<ServiceInfo>, String>>();
    {
        let mut inner = state.lock();
        inner.pending.insert(id.clone(), Pending { generation, cancel: cancel_tx });
    }
    // A task of its own, so ble_disconnect can cancel it and it still cleans up after itself.
    tauri::async_runtime::spawn(connect_task(app.clone(), adapter, id.clone(), generation, limit, cancel_rx, done_tx));
    let result = done_rx.await.unwrap_or_else(|_| Err(CANCELLED.to_string()));
    {
        let mut inner = state.lock();
        if inner.pending.get(&id).is_some_and(|p| p.generation == generation) {
            inner.pending.remove(&id);
        }
    }
    result
}

async fn connect_task(
    app: AppHandle,
    adapter: Adapter,
    id: String,
    generation: u64,
    limit: Duration,
    mut cancel: oneshot::Receiver<()>,
    done: oneshot::Sender<Result<Vec<ServiceInfo>, String>>,
) {
    let result = open_connection(&app, &adapter, &id, generation, limit, &mut cancel).await;
    let _ = done.send(result);
}

enum Step<T> {
    Done(T),
    TimedOut,
    Cancelled,
}

/// Runs `work` until it finishes, the deadline passes or the connect is cancelled.
async fn until<F: Future>(deadline: tokio::time::Instant, cancel: &mut oneshot::Receiver<()>, work: F) -> Step<F::Output> {
    tokio::select! {
        out = tokio::time::timeout_at(deadline, work) => match out {
            Ok(value) => Step::Done(value),
            Err(_) => Step::TimedOut,
        },
        _ = cancel => Step::Cancelled,
    }
}

#[derive(Default)]
struct Found {
    metas: Vec<CharMeta>,
    chars: Vec<Characteristic>,
    services: Vec<ServiceInfo>,
}

/// Opens the device by its id (no scan needed), connects, discovers and registers the
/// connection. Releases the link on every failure.
async fn open_connection(
    app: &AppHandle,
    adapter: &Adapter,
    id: &str,
    generation: u64,
    limit: Duration,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<Vec<ServiceInfo>, String> {
    let device_id = parse_device_id(id).ok_or_else(|| NOT_FOUND.to_string())?;
    let deadline = tokio::time::Instant::now() + limit;
    let device = match until(deadline, cancel, adapter.open_device(&device_id)).await {
        Step::Done(Ok(device)) => device,
        Step::Done(Err(_)) => return Err(NOT_FOUND.to_string()),
        Step::TimedOut => return Err(TIMED_OUT.to_string()),
        Step::Cancelled => return Err(CANCELLED.to_string()),
    };
    let outcome = match until(deadline, cancel, establish(app, adapter, &device, id)).await {
        Step::Done(result) => result,
        Step::TimedOut => Err(TIMED_OUT.to_string()),
        Step::Cancelled => Err(CANCELLED.to_string()),
    };
    let found = match outcome {
        Ok(found) => found,
        Err(e) => {
            // Never leave a half-open link behind (pending connect, failed discovery, cancel).
            release(adapter, &device).await;
            return Err(e);
        }
    };
    let Found { metas, chars, services } = found;
    let state = app.state::<BleState>();
    let connection = Connection {
        generation,
        device: device.clone(),
        metas,
        chars,
        services: services.clone(),
        watcher: None,
        pumps: HashMap::new(),
        notify_gate: Arc::default(),
    };
    let replaced = {
        let mut inner = state.lock();
        inner.connections.insert(id.to_string(), connection)
    };
    if let Some(old) = replaced {
        old.shutdown().await;
    }
    // The watcher starts after the entry exists, so an immediate disconnect finds it.
    let watcher = spawn_watcher(app.clone(), adapter.clone(), device, id.to_string(), generation);
    let orphan = {
        let mut inner = state.lock();
        match inner.connections.get_mut(id) {
            Some(connection) if connection.generation == generation => {
                connection.watcher = Some(watcher);
                None
            }
            _ => Some(watcher),
        }
    };
    if let Some(orphan) = orphan {
        orphan.abort();
    }
    Ok(services)
}

/// Connects (where the platform needs it) and lists every service and characteristic.
async fn establish(app: &AppHandle, adapter: &Adapter, device: &Device, id: &str) -> Result<Found, String> {
    if !device.is_connected().await {
        connect_link(app, adapter, device, id).await.map_err(err)?;
    }
    let services = device.discover_services().await.map_err(err)?;
    let mut found = Found::default();
    for (index, service) in services.iter().enumerate() {
        let Ok(service_uuid) = service.uuid_async().await else { continue };
        // Services the system does not let us use (Windows: HID) are skipped, as in Web Bluetooth.
        let Ok(list) = service.discover_characteristics().await else { continue };
        let mut infos = Vec::new();
        for ch in list {
            let Ok(uuid) = ch.uuid_async().await else { continue };
            let Ok(properties) = ch.properties().await else { continue };
            let props = Properties::from_bluest(&properties);
            infos.push(CharacteristicInfo { uuid: uuid.to_string(), properties: props });
            found.metas.push(CharMeta { service_index: index, service: service_uuid, uuid, props });
            found.chars.push(ch);
        }
        found.services.push(ServiceInfo { uuid: service_uuid.to_string(), characteristics: infos });
    }
    if found.chars.is_empty() {
        // Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
        return Err("The device did not report any GATT characteristics".to_string());
    }
    Ok(found)
}

/// Windows: a no-op (the system connects on the first GATT call). macOS: required before GATT
/// calls; dropping the future cancels the pending connection.
#[cfg(not(target_os = "linux"))]
async fn connect_link(_app: &AppHandle, adapter: &Adapter, device: &Device, _id: &str) -> bluest::Result<()> {
    adapter.connect_device(device).await
}

/// Linux: BlueZ Connect. A device object that BlueZ removed is discovered again first.
#[cfg(target_os = "linux")]
async fn connect_link(app: &AppHandle, adapter: &Adapter, device: &Device, id: &str) -> bluest::Result<()> {
    match adapter.connect_device(device).await {
        Err(e) if matches!(e.kind(), ErrorKind::NotFound) => {
            linux_wait_for(app, id, Duration::from_secs(10)).await;
            adapter.connect_device(device).await
        }
        other => other,
    }
}

/// Linux: BlueZ keeps a link made over D-Bus, even a pending Connect, until Disconnect is called
/// (also after the app exits), so always disconnect.
#[cfg(target_os = "linux")]
async fn release(adapter: &Adapter, device: &Device) {
    let _ = timeout(RELEASE_TIMEOUT, adapter.disconnect_device(device)).await;
}

/// macOS: a pending connect was cancelled when its future was dropped. disconnect_device waits
/// for the disconnect callback, so it is called only for a connected device.
#[cfg(target_os = "macos")]
async fn release(adapter: &Adapter, device: &Device) {
    if device.is_connected().await {
        let _ = timeout(RELEASE_TIMEOUT, adapter.disconnect_device(device)).await;
    }
}

/// Windows: the link closes when the device and every object obtained from it are dropped.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn release(_adapter: &Adapter, _device: &Device) {}

/// Watches one connection and reports its end once.
fn spawn_watcher(app: AppHandle, adapter: Adapter, device: Device, id: String, generation: u64) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        match adapter.device_connection_events(&device).await {
            Ok(mut events) => {
                // Events report changes only: the link may be gone already.
                if device.is_connected().await {
                    while let Some(event) = events.next().await {
                        if event == ConnectionEvent::Disconnected {
                            break;
                        }
                    }
                }
                // The stream also ends when the macOS adapter is switched off.
            }
            Err(_) => {
                while device.is_connected().await {
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
        }
        lost(&app, &id, generation);
    })
}

/// The link of a tracked connection dropped: forget it and tell the web app. Only the
/// connection of this generation is removed, never a newer one of the same device.
fn lost(app: &AppHandle, id: &str, generation: u64) {
    let state = app.state::<BleState>();
    let removed = {
        let mut inner = state.lock();
        if inner.connections.get(id).is_some_and(|c| c.generation == generation) {
            inner.connections.remove(id)
        } else {
            None
        }
    };
    let Some(mut connection) = removed else { return };
    // This task is the watcher: detach its own handle instead of aborting it.
    drop(connection.watcher.take());
    for (_, pump) in connection.pumps.drain() {
        pump.abort();
    }
    drop(connection);
    let _ = app.emit("ble://disconnected", Disconnected { id: id.to_string() });
}

#[tauri::command]
pub async fn ble_services(state: State<'_, BleState>, id: String) -> Result<Vec<ServiceInfo>, String> {
    let services = {
        let inner = state.lock();
        inner.connections.get(&id).map(|c| c.services.clone())
    };
    services.ok_or_else(|| NOT_CONNECTED.to_string())
}

#[tauri::command]
pub async fn ble_disconnect(state: State<'_, BleState>, id: String) -> Result<(), String> {
    disconnect_id(&state, &id).await;
    Ok(())
}

/// Cancels a pending connect, closes a tracked connection, and releases an untracked device
/// (a connect that failed or was cancelled earlier).
async fn disconnect_id(state: &BleState, id: &str) {
    let pending = {
        let mut inner = state.lock();
        inner.pending.remove(id)
    };
    if let Some(pending) = pending {
        // The connect task stops and releases its half-open link itself.
        let _ = pending.cancel.send(());
    }
    // Wait until a running ble_connect for this device has returned.
    let gate = state.gate(id);
    let _turn = gate.lock().await;
    let Some(adapter) = state.adapter.get().cloned() else { return };
    let connection = {
        let mut inner = state.lock();
        inner.connections.remove(id)
    };
    let device = match connection {
        Some(connection) => {
            let device = connection.device.clone();
            connection.shutdown().await;
            device
        }
        None => {
            if cfg!(target_os = "windows") {
                // Nothing of ours keeps an untracked device connected on Windows.
                return;
            }
            let Some(device_id) = parse_device_id(id) else { return };
            match timeout(RELEASE_TIMEOUT, adapter.open_device(&device_id)).await {
                Ok(Ok(device)) => device,
                _ => return,
            }
        }
    };
    release(&adapter, &device).await;
}

/// Stops the scan and closes every connection and pending connect (webview reload, app exit).
pub async fn close_all(app: &AppHandle) {
    let state = app.state::<BleState>();
    {
        let _turn = state.scan_gate.lock().await;
        stop_scan(&state).await;
    }
    let mut ids: Vec<String> = Vec::new();
    {
        let inner = state.lock();
        ids.extend(inner.pending.keys().cloned());
        ids.extend(inner.connections.keys().cloned());
    }
    ids.sort();
    ids.dedup();
    for id in ids {
        disconnect_id(&state, &id).await;
    }
}

// ---------------------------------------------------------------------------------------------
// Notifications and writes

fn notify_gate(state: &BleState, id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let inner = state.lock();
    let gate = inner.connections.get(id).map(|c| c.notify_gate.clone());
    gate.ok_or_else(|| NOT_CONNECTED.to_string())
}

#[tauri::command]
pub async fn ble_subscribe(
    app: AppHandle,
    state: State<'_, BleState>,
    id: String,
    service: String,
    characteristic: String,
) -> Result<(), String> {
    let service = parse_uuid(&service)?;
    let uuid = parse_uuid(&characteristic)?;
    let gate = notify_gate(&state, &id)?;
    let _turn = gate.lock().await;
    let (index, ch, generation) = {
        let inner = state.lock();
        let connection = inner.connections.get(&id).ok_or_else(|| NOT_CONNECTED.to_string())?;
        let index = pick(&connection.metas, service, uuid, can_notify).ok_or_else(|| missing(service, uuid))?;
        if connection.pumps.contains_key(&index) {
            return Ok(());
        }
        (index, connection.chars[index].clone(), connection.generation)
    };
    let (started_tx, started_rx) = oneshot::channel::<Result<(), String>>();
    let pump = tauri::async_runtime::spawn(pump_task(app.clone(), ch, id.clone(), service, uuid, started_tx));
    // Wait for the CCCD write, so its errors reach JavaScript.
    let started = match timeout(SUBSCRIBE_TIMEOUT, started_rx).await {
        Ok(Ok(result)) => result,
        // Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
        Ok(Err(_)) => Err("Notifications could not be enabled".to_string()),
        Err(_) => Err("Enabling notifications timed out".to_string()),
    };
    if let Err(e) = started {
        pump.abort();
        return Err(e);
    }
    let orphan = {
        let mut inner = state.lock();
        match inner.connections.get_mut(&id) {
            Some(connection) if connection.generation == generation => connection.pumps.insert(index, pump),
            // The connection ended meanwhile.
            _ => Some(pump),
        }
    };
    if let Some(orphan) = orphan {
        orphan.abort();
    }
    Ok(())
}

/// Owns one notify stream and forwards every value at once, in order and unmerged (the system
/// queues behind the stream are small).
async fn pump_task(
    app: AppHandle,
    ch: Characteristic,
    id: String,
    service: Uuid,
    uuid: Uuid,
    started: oneshot::Sender<Result<(), String>>,
) {
    let mut stream = match ch.notify().await {
        Ok(stream) => stream,
        Err(e) => {
            let _ = started.send(Err(e.to_string()));
            return;
        }
    };
    let _ = started.send(Ok(()));
    let service = service.to_string();
    let characteristic = uuid.to_string();
    while let Some(item) = stream.next().await {
        let Ok(data) = item else { break };
        let payload = Notification { id: id.clone(), service: service.clone(), characteristic: characteristic.clone(), data };
        let _ = app.emit("ble://notify", payload);
    }
}

#[tauri::command]
pub async fn ble_unsubscribe(
    state: State<'_, BleState>,
    id: String,
    service: String,
    characteristic: String,
) -> Result<(), String> {
    let service = parse_uuid(&service)?;
    let uuid = parse_uuid(&characteristic)?;
    let Ok(gate) = notify_gate(&state, &id) else { return Ok(()) };
    let _turn = gate.lock().await;
    let pump = {
        let mut inner = state.lock();
        match inner.connections.get_mut(&id) {
            Some(connection) => match pick(&connection.metas, service, uuid, can_notify) {
                Some(index) => connection.pumps.remove(&index),
                None => None,
            },
            None => None,
        }
    };
    if let Some(pump) = pump {
        // Dropping the stream turns notifications off on exactly this characteristic.
        pump.abort();
        let _ = pump.await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ble_write(
    state: State<'_, BleState>,
    id: String,
    service: String,
    characteristic: String,
    data: Vec<u8>,
    with_response: Option<bool>,
) -> Result<(), String> {
    let service = parse_uuid(&service)?;
    let uuid = parse_uuid(&characteristic)?;
    let (ch, props) = {
        let inner = state.lock();
        let connection = inner.connections.get(&id).ok_or_else(|| NOT_CONNECTED.to_string())?;
        let index = pick(&connection.metas, service, uuid, can_write).ok_or_else(|| missing(service, uuid))?;
        (connection.chars[index].clone(), connection.metas[index].props)
    };
    let request = use_write_request(with_response.unwrap_or(true), &props);
    let write = async {
        if request {
            ch.write(&data).await
        } else {
            ch.write_without_response(&data).await
        }
    };
    let outcome = timeout(WRITE_TIMEOUT, write).await;
    match outcome {
        Ok(result) => result.map_err(err),
        // Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
        Err(_) => Err("Bluetooth write timed out".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid16(short: u16) -> Uuid {
        Uuid::parse_str(&format!("0000{short:04x}-0000-1000-8000-00805f9b34fb")).unwrap()
    }

    fn props(bits: u32) -> Properties {
        Properties::from_bluest(&CharacteristicProperties::from_bits(bits))
    }

    fn meta(service_index: usize, service: u16, uuid: u16, bits: u32) -> CharMeta {
        CharMeta { service_index, service: uuid16(service), uuid: uuid16(uuid), props: props(bits) }
    }

    #[test]
    fn properties_follow_the_gatt_bits() {
        assert_eq!(props(0x0C), Properties { write: true, write_without_response: true, ..Properties::default() });
        assert_eq!(props(0x12), Properties { read: true, notify: true, ..Properties::default() });
    }

    #[test]
    fn jk_new_module_picks_the_duplicate_ffe1_by_properties() {
        // docs/protocols/jk.md: FFE1 0x0C (write) at handle 0x03, FFE1 0x12 (notify) at 0x05.
        let metas = [meta(0, 0x1800, 0x2a00, 0x02), meta(1, 0xffe0, 0xffe1, 0x0C), meta(1, 0xffe0, 0xffe1, 0x12)];
        let (ffe0, ffe1) = (uuid16(0xffe0), uuid16(0xffe1));
        assert_eq!(pick(&metas, ffe0, ffe1, can_notify), Some(2));
        assert_eq!(pick(&metas, ffe0, ffe1, can_write), Some(1));
    }

    #[test]
    fn jk_old_module_uses_its_single_ffe1() {
        let metas = [meta(0, 0xffe0, 0xffe2, 0x04), meta(0, 0xffe0, 0xffe1, 0x1C)];
        let (ffe0, ffe1) = (uuid16(0xffe0), uuid16(0xffe1));
        assert_eq!(pick(&metas, ffe0, ffe1, can_notify), Some(1));
        assert_eq!(pick(&metas, ffe0, ffe1, can_write), Some(1));
        assert_eq!(pick(&metas, ffe0, uuid16(0xffe3), can_write), None);
        assert_eq!(pick(&metas, uuid16(0xfff0), ffe1, can_write), None);
    }

    #[test]
    fn pick_falls_back_to_the_first_match_and_the_first_service_instance() {
        let metas = [meta(0, 0xffe0, 0xffe1, 0x02), meta(1, 0xffe0, 0xffe1, 0x10)];
        // Like getPrimaryService: only the first FFE0 counts; without notify the first FFE1 is used.
        assert_eq!(pick(&metas, uuid16(0xffe0), uuid16(0xffe1), can_notify), Some(0));
    }

    #[test]
    fn write_type_follows_the_request_and_the_properties() {
        assert!(use_write_request(true, &props(0x0C)));
        assert!(!use_write_request(false, &props(0x0C)));
        assert!(!use_write_request(true, &props(0x04)), "write without response only");
        assert!(use_write_request(false, &props(0x08)), "write request only");
        assert!(!use_write_request(false, &props(0x1C)));
    }

    #[test]
    fn device_ids_round_trip() {
        #[cfg(target_os = "windows")]
        let key = "BluetoothLE#BluetoothLE00:1a:7d:da:71:13-c8:47:8c:00:00:01";
        #[cfg(target_os = "macos")]
        let key = "6f1c0a8e-0b5e-4e8c-9a51-7b1f6d2c3e4a";
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let key = "C8:47:8C:00:00:01";
        let id = parse_device_id(key).expect("the id parses");
        assert_eq!(device_key(&id), key);
        assert!(parse_device_id("").is_none());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ids_of_older_builds_do_not_parse() {
        assert!(parse_device_id("PeripheralId(C8:47:8C:00:00:01)").is_none());
    }

    #[test]
    fn empty_filters_match_everything() {
        let f = ScanFilters::default();
        assert!(matches(&f, &[], "anything", &[], &HashMap::new()));
    }

    #[test]
    fn name_prefix_service_or_manufacturer_match() {
        let f = ScanFilters { name_prefixes: vec!["JK-".into(), "JK_".into()], services: vec![], manufacturer_ids: vec![0x0102] };
        assert!(matches(&f, &[], "JK_PB2A16S20P", &[], &HashMap::new()));
        assert!(!matches(&f, &[], "ANT-BLE16ZMUB", &[], &HashMap::new()));
        let mut m = HashMap::new();
        m.insert(0x0102u16, vec![1, 2]);
        assert!(matches(&f, &[], "DL-40D63C3223A2", &[], &m));
        let ffe0 = uuid16(0xffe0);
        let g = ScanFilters { name_prefixes: vec![], services: vec![ffe0.to_string()], manufacturer_ids: vec![] };
        assert!(matches(&g, &[ffe0], "", &[ffe0], &HashMap::new()));
    }

    #[test]
    fn scan_merger_throttles_rssi_only_updates_per_device() {
        let mut m = ScanMerger::new(ScanFilters::default());
        let t0 = Instant::now();
        let none = HashMap::new();
        let first = m.update("a", Some("JK_B2A24S".into()), Some(-60), &[], &none, t0).expect("first sighting");
        assert_eq!(first.rssi, Some(-60));
        assert!(m.update("a", None, Some(-61), &[], &none, t0 + Duration::from_millis(300)).is_none());
        let later = m.update("a", None, Some(-62), &[], &none, t0 + Duration::from_millis(1100)).expect("after a second");
        assert_eq!((later.rssi, later.name.as_str()), (Some(-62), "JK_B2A24S"));
        let ffe0 = uuid16(0xffe0);
        let more = m.update("a", None, None, &[ffe0], &none, t0 + Duration::from_millis(1200)).expect("new service");
        assert_eq!(more.services, vec![ffe0.to_string()]);
        assert!(m.update("b", None, Some(-70), &[], &none, t0 + Duration::from_millis(1200)).is_some(), "own throttle");
        assert!(m.has_name("a") && !m.has_name("b"));
    }

    #[test]
    fn scan_merger_reports_a_device_once_its_scan_response_matches() {
        let f = ScanFilters { name_prefixes: vec!["JK".into()], services: vec![], manufacturer_ids: vec![] };
        let mut m = ScanMerger::new(f);
        let t0 = Instant::now();
        let none = HashMap::new();
        assert!(m.update("a", None, Some(-60), &[], &none, t0).is_none(), "advertisement without a name");
        let found = m.update("a", Some("JK-BMS".into()), None, &[], &none, t0 + Duration::from_millis(50)).expect("match");
        assert_eq!(found.rssi, Some(-60));
    }

    #[test]
    fn adapter_errors_map_to_states_and_texts() {
        let s = init_error_status(ErrorKind::NotFound, "not found".into());
        assert_eq!((s.state, s.reason), ("unavailable", Some("no-adapter")));
        let s = init_error_status(ErrorKind::Other, "dbus".into());
        let expected = if cfg!(target_os = "windows") { "no-adapter" } else { "error" };
        assert_eq!(s.reason, Some(expected));
        let s = query_error_status(ErrorKind::NotAuthorized, "denied".into());
        assert_eq!((s.state, s.reason), ("unauthorized", Some("permission-denied")));
        let s = query_error_status(ErrorKind::Other, "boom".into());
        assert_eq!((s.state, s.reason, s.detail.as_deref()), ("unavailable", Some("error"), Some("boom")));
        assert_eq!(s.error_text(), "boom");
        assert!(AdapterStatus::on().is_on() && !AdapterStatus::new("off", "powered-off", None).is_on());
        assert_eq!(
            AdapterStatus::new("off", "powered-off", None).error_text(),
            "Bluetooth is switched off or no Bluetooth adapter was found."
        );
    }

    #[test]
    fn timeouts_are_clamped() {
        let (min, max) = (Duration::from_secs(1), Duration::from_secs(120));
        assert_eq!(duration_ms(None, CONNECT_TIMEOUT, min, max), CONNECT_TIMEOUT);
        assert_eq!(duration_ms(Some(10), CONNECT_TIMEOUT, min, max), min);
        assert_eq!(duration_ms(Some(u64::MAX), CONNECT_TIMEOUT, min, max), max);
    }
}
