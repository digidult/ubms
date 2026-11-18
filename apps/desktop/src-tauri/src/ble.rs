//! Bluetooth Low Energy bridge on top of btleplug.
//!
//! Commands and events follow `docs/tauri.md`. Device ids are the Debug form of btleplug's
//! `PeripheralId`: opaque, stable while the app runs, and the same in events and commands.
//! Several characteristics may share one UUID (JK BMS modules expose a write-only FFE1 and a
//! notify FFE1), so characteristics are always picked by UUID and by their properties.

use std::collections::HashMap;
use std::time::Duration;

use btleplug::api::{
    Central as _, CentralEvent, CentralState, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter,
    WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager as _, State};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::err;

/// Shared Bluetooth state: the adapter, background tasks and connected devices.
#[derive(Default)]
pub struct BleState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    manager: Option<Manager>,
    adapter: Option<Adapter>,
    /// Forwards adapter events (disconnects) to the web app.
    watcher: Option<JoinHandle<()>>,
    /// Running scan, if any.
    scan: Option<JoinHandle<()>>,
    connected: HashMap<String, Peripheral>,
    /// One notification pump per connected device.
    pumps: HashMap<String, JoinHandle<()>>,
}

/// Scan filters sent by the web app; a device matches when any filter matches,
/// and every device matches when all lists are empty.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanFilters {
    name_prefixes: Vec<String>,
    services: Vec<String>,
    manufacturer_ids: Vec<u16>,
}

#[derive(Serialize, Clone)]
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
    characteristic: String,
    data: Vec<u8>,
}

/// A GATT service with its characteristics, as returned to the web app.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    uuid: String,
    characteristics: Vec<CharacteristicInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CharacteristicInfo {
    uuid: String,
    properties: Properties,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Properties {
    read: bool,
    write: bool,
    write_without_response: bool,
    notify: bool,
    indicate: bool,
}

fn device_key(id: &impl std::fmt::Debug) -> String {
    format!("{id:?}")
}

/// The first adapter, created on demand. Also starts the disconnect watcher.
async fn adapter(app: &AppHandle, inner: &mut Inner) -> Result<Adapter, String> {
    if let Some(adapter) = &inner.adapter {
        return Ok(adapter.clone());
    }
    let manager = Manager::new().await.map_err(err)?;
    let adapter = manager
        .adapters()
        .await
        .map_err(err)?
        .into_iter()
        .next()
        .ok_or_else(|| "No Bluetooth adapter found".to_string())?;
    let mut events = adapter.events().await.map_err(err)?;
    let app = app.clone();
    inner.watcher = Some(tauri::async_runtime::spawn(async move {
        while let Some(event) = events.next().await {
            if let CentralEvent::DeviceDisconnected(id) = event {
                let key = device_key(&id);
                {
                    let state = app.state::<BleState>();
                    let mut inner = state.inner.lock().await;
                    inner.connected.remove(&key);
                    if let Some(pump) = inner.pumps.remove(&key) {
                        pump.abort();
                    }
                }
                let _ = app.emit("ble://disconnected", Disconnected { id: key });
            }
        }
    }));
    inner.manager = Some(manager);
    inner.adapter = Some(adapter.clone());
    Ok(adapter)
}

#[tauri::command]
pub async fn ble_adapter_state(app: AppHandle, state: State<'_, BleState>) -> Result<String, String> {
    let adapter = {
        let mut inner = state.inner.lock().await;
        match adapter(&app, &mut inner).await {
            Ok(adapter) => adapter,
            Err(_) => return Ok("unavailable".into()),
        }
    };
    let text = match adapter.adapter_state().await {
        Ok(CentralState::PoweredOff) => "off",
        // Unknown: some backends cannot tell; let a scan report real problems.
        Ok(CentralState::PoweredOn) | Ok(CentralState::Unknown) | Err(_) => "on",
    };
    Ok(text.into())
}

fn matches(filters: &ScanFilters, services: &[Uuid], name: &str, advertised: &[Uuid], manufacturer: &HashMap<u16, Vec<u8>>) -> bool {
    if filters.name_prefixes.is_empty() && services.is_empty() && filters.manufacturer_ids.is_empty() {
        return true;
    }
    filters.name_prefixes.iter().any(|p| name.starts_with(p.as_str()))
        || services.iter().any(|s| advertised.contains(s))
        || filters.manufacturer_ids.iter().any(|m| manufacturer.contains_key(m))
}

#[tauri::command]
pub async fn ble_scan_start(
    app: AppHandle,
    state: State<'_, BleState>,
    filters: Option<ScanFilters>,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let filters = filters.unwrap_or_default();
    let mut inner = state.inner.lock().await;
    let adapter = adapter(&app, &mut inner).await?;
    if let Some(task) = inner.scan.take() {
        task.abort();
    }
    let mut events = adapter.events().await.map_err(err)?;
    adapter.start_scan(ScanFilter::default()).await.map_err(err)?;
    let wanted: Vec<Uuid> = filters.services.iter().filter_map(|s| Uuid::parse_str(s).ok()).collect();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000));
    let scan_adapter = adapter.clone();
    inner.scan = Some(tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            let event = tokio::select! {
                _ = &mut deadline => break,
                event = events.next() => match event {
                    Some(event) => event,
                    None => break,
                },
            };
            let id = match event {
                CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => id,
                CentralEvent::ManufacturerDataAdvertisement { id, .. }
                | CentralEvent::ServicesAdvertisement { id, .. }
                | CentralEvent::RssiUpdate { id, .. } => id,
                _ => continue,
            };
            let Ok(peripheral) = scan_adapter.peripheral(&id).await else {
                continue;
            };
            let Ok(Some(props)) = peripheral.properties().await else {
                continue;
            };
            let name = props.local_name.clone().or_else(|| props.advertisement_name.clone()).unwrap_or_default();
            if !matches(&filters, &wanted, &name, &props.services, &props.manufacturer_data) {
                continue;
            }
            let _ = app.emit(
                "ble://device",
                FoundDevice {
                    id: device_key(&id),
                    name,
                    rssi: props.rssi,
                    services: props.services.iter().map(|u| u.to_string()).collect(),
                    manufacturer_data: props.manufacturer_data.clone(),
                },
            );
        }
        let _ = scan_adapter.stop_scan().await;
    }));
    Ok(())
}

#[tauri::command]
pub async fn ble_scan_stop(state: State<'_, BleState>) -> Result<(), String> {
    let adapter = {
        let mut inner = state.inner.lock().await;
        if let Some(task) = inner.scan.take() {
            task.abort();
        }
        inner.adapter.clone()
    };
    if let Some(adapter) = adapter {
        let _ = adapter.stop_scan().await;
    }
    Ok(())
}

async fn find(adapter: &Adapter, id: &str) -> Result<Peripheral, String> {
    for peripheral in adapter.peripherals().await.map_err(err)? {
        if device_key(&peripheral.id()) == id {
            return Ok(peripheral);
        }
    }
    Err("Device not found, scan again".into())
}

fn service_info(peripheral: &Peripheral) -> Vec<ServiceInfo> {
    peripheral
        .services()
        .iter()
        .map(|s| ServiceInfo {
            uuid: s.uuid.to_string(),
            characteristics: s
                .characteristics
                .iter()
                .map(|c| CharacteristicInfo {
                    uuid: c.uuid.to_string(),
                    properties: Properties {
                        read: c.properties.contains(CharPropFlags::READ),
                        write: c.properties.contains(CharPropFlags::WRITE),
                        write_without_response: c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE),
                        notify: c.properties.contains(CharPropFlags::NOTIFY),
                        indicate: c.properties.contains(CharPropFlags::INDICATE),
                    },
                })
                .collect(),
        })
        .collect()
}

#[tauri::command]
pub async fn ble_connect(
    app: AppHandle,
    state: State<'_, BleState>,
    id: String,
    timeout_ms: Option<u64>,
) -> Result<Vec<ServiceInfo>, String> {
    let adapter = {
        let mut inner = state.inner.lock().await;
        adapter(&app, &mut inner).await?
    };
    let peripheral = find(&adapter, &id).await?;
    if !peripheral.is_connected().await.unwrap_or(false) {
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000));
        peripheral.connect_with_timeout(timeout).await.map_err(err)?;
    }
    peripheral.discover_services().await.map_err(err)?;
    let services = service_info(&peripheral);
    state.inner.lock().await.connected.insert(id, peripheral);
    Ok(services)
}

async fn connected(state: &State<'_, BleState>, id: &str) -> Result<Peripheral, String> {
    state
        .inner
        .lock()
        .await
        .connected
        .get(id)
        .cloned()
        .ok_or_else(|| "Bluetooth device is not connected".to_string())
}

#[tauri::command]
pub async fn ble_services(state: State<'_, BleState>, id: String) -> Result<Vec<ServiceInfo>, String> {
    let peripheral = connected(&state, &id).await?;
    Ok(service_info(&peripheral))
}

/// The characteristic with this service and UUID that has one of the wanted properties
/// (falls back to the first one with the UUID).
fn pick(peripheral: &Peripheral, service: &str, characteristic: &str, want: CharPropFlags) -> Result<Characteristic, String> {
    let service = Uuid::parse_str(service).map_err(err)?;
    let uuid = Uuid::parse_str(characteristic).map_err(err)?;
    let candidates: Vec<Characteristic> = peripheral
        .characteristics()
        .into_iter()
        .filter(|c| c.uuid == uuid && c.service_uuid == service)
        .collect();
    candidates
        .iter()
        .find(|c| c.properties.intersects(want))
        .or_else(|| candidates.first())
        .cloned()
        .ok_or_else(|| format!("Characteristic {characteristic} not found"))
}

#[tauri::command]
pub async fn ble_subscribe(
    app: AppHandle,
    state: State<'_, BleState>,
    id: String,
    service: String,
    characteristic: String,
) -> Result<(), String> {
    let peripheral = connected(&state, &id).await?;
    let ch = pick(&peripheral, &service, &characteristic, CharPropFlags::NOTIFY | CharPropFlags::INDICATE)?;
    {
        // Start the pump before subscribing so that no early notification is lost.
        let mut inner = state.inner.lock().await;
        if !inner.pumps.contains_key(&id) {
            let mut stream = peripheral.notifications().await.map_err(err)?;
            let app = app.clone();
            let device = id.clone();
            inner.pumps.insert(
                id.clone(),
                tauri::async_runtime::spawn(async move {
                    while let Some(n) = stream.next().await {
                        let _ = app.emit(
                            "ble://notify",
                            Notification { id: device.clone(), characteristic: n.uuid.to_string(), data: n.value },
                        );
                    }
                }),
            );
        }
    }
    peripheral.subscribe(&ch).await.map_err(err)
}

#[tauri::command]
pub async fn ble_unsubscribe(state: State<'_, BleState>, id: String, service: String, characteristic: String) -> Result<(), String> {
    let peripheral = connected(&state, &id).await?;
    let ch = pick(&peripheral, &service, &characteristic, CharPropFlags::NOTIFY | CharPropFlags::INDICATE)?;
    peripheral.unsubscribe(&ch).await.map_err(err)
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
    let peripheral = connected(&state, &id).await?;
    let ch = pick(&peripheral, &service, &characteristic, CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE)?;
    let can_with = ch.properties.contains(CharPropFlags::WRITE);
    let can_without = ch.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE);
    let write_type = match (with_response.unwrap_or(true), can_with, can_without) {
        (true, true, _) => WriteType::WithResponse,
        (_, _, true) => WriteType::WithoutResponse,
        _ => WriteType::WithResponse,
    };
    peripheral.write(&ch, &data, write_type).await.map_err(err)
}

#[tauri::command]
pub async fn ble_disconnect(state: State<'_, BleState>, id: String) -> Result<(), String> {
    let (peripheral, pump) = {
        let mut inner = state.inner.lock().await;
        (inner.connected.remove(&id), inner.pumps.remove(&id))
    };
    if let Some(pump) = pump {
        pump.abort();
    }
    if let Some(peripheral) = peripheral {
        peripheral.disconnect().await.map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let ffe0 = Uuid::parse_str("0000ffe0-0000-1000-8000-00805f9b34fb").unwrap();
        let g = ScanFilters { name_prefixes: vec![], services: vec![ffe0.to_string()], manufacturer_ids: vec![] };
        assert!(matches(&g, &[ffe0], "", &[ffe0], &HashMap::new()));
    }
}
