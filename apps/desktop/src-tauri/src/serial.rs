//! Serial port bridge on top of the serialport crate.
//!
//! Commands and events follow `docs/tauri.md`. Every open port has a reader thread that forwards
//! bytes as soon as they arrive (10 ms read timeout), so the JavaScript framers see the same
//! stream a Web Serial reader would deliver. Blocking calls (list, open, write, close) run on the
//! blocking thread pool, and every port has its own lock, so a slow port never holds up another.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::err;

/// Read timeout of the reader thread; also how fast it notices a close.
const READ_TIMEOUT: Duration = Duration::from_millis(10);
/// Upper bound for one write call from JavaScript.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// Open ports by handle id.
#[derive(Default)]
pub struct SerialState {
    /// Never held during I/O.
    ports: Mutex<HashMap<String, Arc<OpenPort>>>,
    next: AtomicU64,
}

struct OpenPort {
    /// The per-port lock: writes to one port are serialized, other ports are not affected.
    writer: Mutex<Box<dyn SerialPort>>,
    stop: Arc<AtomicBool>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl SerialState {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<OpenPort>>> {
        self.ports.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn get(&self, handle: &str) -> Option<Arc<OpenPort>> {
        let ports = self.lock();
        let port = ports.get(handle).cloned();
        port
    }

    fn take(&self, handle: &str) -> Option<Arc<OpenPort>> {
        let mut ports = self.lock();
        let port = ports.remove(handle);
        port
    }
}

/// A port as listed for the web app.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    path: String,
    name: String,
    usb_vendor_id: Option<u16>,
    usb_product_id: Option<u16>,
    serial_number: Option<String>,
    manufacturer: Option<String>,
    product: Option<String>,
}

/// Output signals applied after opening (some isolated RS485 adapters need DTR or RTS).
#[derive(Deserialize, Default, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Signals {
    data_terminal_ready: Option<bool>,
    request_to_send: Option<bool>,
}

/// Result of `serial_open`.
#[derive(Serialize)]
pub struct Opened {
    handle: String,
    /// Problems that did not prevent opening, for the protocol log (for example DTR refused).
    warnings: Vec<String>,
}

#[derive(Serialize, Clone)]
struct DataEvent {
    handle: String,
    data: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct ClosedEvent {
    handle: String,
    reason: String,
}

fn port_info(p: SerialPortInfo) -> PortInfo {
    let mut info = PortInfo {
        name: p.port_name.clone(),
        path: p.port_name,
        usb_vendor_id: None,
        usb_product_id: None,
        serial_number: None,
        manufacturer: None,
        product: None,
    };
    if let SerialPortType::UsbPort(usb) = p.port_type {
        info.usb_vendor_id = Some(usb.vid);
        info.usb_product_id = Some(usb.pid);
        if let Some(product) = &usb.product {
            info.name = format!("{product} ({})", info.path);
        }
        info.serial_number = usb.serial_number;
        info.manufacturer = usb.manufacturer;
        info.product = usb.product;
    }
    info
}

/// macOS lists every serial device twice: /dev/cu.X (call-out) and /dev/tty.X (dial-in, whose
/// open waits for carrier detect). Only the cu device is offered.
fn is_dial_in_twin(path: &str, all: &[String]) -> bool {
    match path.strip_prefix("/dev/tty.") {
        Some(rest) => all.iter().any(|p| p.strip_prefix("/dev/cu.") == Some(rest)),
        None => false,
    }
}

#[tauri::command]
pub async fn serial_list() -> Result<Vec<PortInfo>, String> {
    let ports = tauri::async_runtime::spawn_blocking(serialport::available_ports).await.map_err(err)?.map_err(err)?;
    let paths: Vec<String> = ports.iter().map(|p| p.port_name.clone()).collect();
    let list = ports
        .into_iter()
        .filter(|p| !(cfg!(target_os = "macos") && is_dial_in_twin(&p.port_name, &paths)))
        .map(port_info)
        .collect();
    Ok(list)
}

fn data_bits(bits: Option<u8>) -> DataBits {
    match bits.unwrap_or(8) {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

fn stop_bits(bits: Option<u8>) -> StopBits {
    if bits == Some(2) {
        StopBits::Two
    } else {
        StopBits::One
    }
}

fn parity(value: Option<&str>) -> Parity {
    match value {
        Some("even") => Parity::Even,
        Some("odd") => Parity::Odd,
        _ => Parity::None,
    }
}

fn flow_control(value: Option<&str>) -> FlowControl {
    if value == Some("hardware") {
        FlowControl::Hardware
    } else {
        FlowControl::None
    }
}

/// DTR and RTS levels to set after opening (None: leave as is). Web Serial and Unix open a port
/// with both raised, Windows with both low; raising them by default gives every platform the same
/// start. With hardware flow control the driver owns RTS, so it is set only when asked for.
fn signal_levels(signals: Signals, hardware_flow: bool) -> (Option<bool>, Option<bool>) {
    let dtr = Some(signals.data_terminal_ready.unwrap_or(true));
    let rts = match signals.request_to_send {
        Some(level) => Some(level),
        None if hardware_flow => None,
        None => Some(true),
    };
    (dtr, rts)
}

struct OpenRequest {
    path: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
    flow_control: Option<String>,
    dtr: Option<bool>,
    rts: Option<bool>,
}

type OpenedPorts = (Box<dyn SerialPort>, Box<dyn SerialPort>, Vec<String>);

/// Opens the port (blocking) and sets the output signals. A refused signal is a warning, not an
/// error: some adapters do not support it, and the port works anyway.
fn open_port(req: &OpenRequest) -> Result<OpenedPorts, String> {
    let mut port = serialport::new(&req.path, req.baud_rate)
        .data_bits(data_bits(req.data_bits))
        .stop_bits(stop_bits(req.stop_bits))
        .parity(parity(req.parity.as_deref()))
        .flow_control(flow_control(req.flow_control.as_deref()))
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(err)?;
    let mut warnings = Vec::new();
    if let Some(level) = req.dtr {
        if let Err(e) = port.write_data_terminal_ready(level) {
            warnings.push(format!("Could not set DTR on {}: {e}", req.path));
        }
    }
    if let Some(level) = req.rts {
        if let Err(e) = port.write_request_to_send(level) {
            warnings.push(format!("Could not set RTS on {}: {e}", req.path));
        }
    }
    let reader = port.try_clone().map_err(err)?;
    Ok((port, reader, warnings))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn serial_open(
    app: AppHandle,
    state: State<'_, SerialState>,
    path: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
    flow_control: Option<String>,
    signals: Option<Signals>,
) -> Result<Opened, String> {
    let hardware_flow = flow_control.as_deref() == Some("hardware");
    let (dtr, rts) = signal_levels(signals.unwrap_or_default(), hardware_flow);
    let request = OpenRequest { path, baud_rate, data_bits, stop_bits, parity, flow_control, dtr, rts };
    let (writer, reader, warnings) =
        tauri::async_runtime::spawn_blocking(move || open_port(&request)).await.map_err(err)??;
    let handle = format!("serial-{}", state.next.fetch_add(1, Ordering::Relaxed) + 1);
    let stop = Arc::new(AtomicBool::new(false));
    let port = Arc::new(OpenPort { writer: Mutex::new(writer), stop: stop.clone(), reader: Mutex::new(None) });
    // Register before the reader starts, so that a read error right away finds the entry.
    {
        let mut ports = state.lock();
        ports.insert(handle.clone(), port.clone());
    }
    match spawn_reader(app, handle.clone(), reader, stop) {
        Ok(thread) => {
            let mut slot = port.reader.lock().unwrap_or_else(PoisonError::into_inner);
            *slot = Some(thread);
        }
        Err(e) => {
            let _ = state.take(&handle);
            return Err(err(e));
        }
    }
    Ok(Opened { handle, warnings })
}

fn is_transient(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock)
}

fn spawn_reader(
    app: AppHandle,
    handle: String,
    mut reader: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
) -> io::Result<JoinHandle<()>> {
    std::thread::Builder::new().name(format!("ubms-{handle}")).spawn(move || {
        let mut buf = [0u8; 4096];
        let failure = loop {
            if stop.load(Ordering::Relaxed) {
                break None;
            }
            match reader.read(&mut buf) {
                Ok(0) => std::thread::sleep(READ_TIMEOUT),
                Ok(n) => {
                    let _ = app.emit("serial://data", DataEvent { handle: handle.clone(), data: buf[..n].to_vec() });
                }
                Err(e) if is_transient(&e) => {}
                Err(e) => break Some(e.to_string()),
            }
        };
        // Close this system handle first, so the port can be opened again at once.
        drop(reader);
        if let Some(reason) = failure {
            if !stop.load(Ordering::Relaxed) {
                // The port is gone (unplugged, driver error): forget it, then tell the web app.
                if let Some(state) = app.try_state::<SerialState>() {
                    let _ = state.take(&handle);
                }
                let _ = app.emit("serial://closed", ClosedEvent { handle, reason });
            }
        }
    })
}

/// Writes everything, retrying while the driver reports a timeout (the port timeout is the
/// short read timeout), for at most `limit`.
fn write_all_within(port: &mut dyn SerialPort, mut data: &[u8], limit: Duration) -> io::Result<()> {
    let start = Instant::now();
    while !data.is_empty() {
        match port.write(data) {
            Ok(n) if n > 0 => data = &data[n..],
            Ok(_) => std::thread::sleep(Duration::from_millis(1)),
            Err(e) if is_transient(&e) => std::thread::sleep(Duration::from_millis(1)),
            Err(e) => return Err(e),
        }
        if !data.is_empty() && start.elapsed() > limit {
            // Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
            return Err(io::Error::new(io::ErrorKind::TimedOut, "Serial write timed out"));
        }
    }
    port.flush()
}

#[tauri::command]
pub async fn serial_write(state: State<'_, SerialState>, handle: String, data: Vec<u8>) -> Result<(), String> {
    // Also listed in packages/transport/src/tauri.js BRIDGE_ERRORS; change both together.
    let port = state.get(&handle).ok_or_else(|| "Serial port is not open".to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut writer = port.writer.lock().unwrap_or_else(PoisonError::into_inner);
        write_all_within(&mut **writer, &data, WRITE_TIMEOUT)
    })
    .await
    .map_err(err)?;
    outcome.map_err(err)
}

/// Stops the reader thread and waits for it, so the system handle is closed when this returns.
fn shutdown(port: &OpenPort) {
    port.stop.store(true, Ordering::Relaxed);
    let thread = port.reader.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(thread) = thread {
        if thread.thread().id() != std::thread::current().id() {
            let _ = thread.join();
        }
    }
}

/// Closing a handle that is already gone (closed by a read error) is not an error.
#[tauri::command]
pub async fn serial_close(state: State<'_, SerialState>, handle: String) -> Result<(), String> {
    let port = state.take(&handle);
    if let Some(port) = port {
        tauri::async_runtime::spawn_blocking(move || shutdown(&port)).await.map_err(err)?;
    }
    Ok(())
}

/// Closes every open port (webview reload, app exit). Blocks for at most a few read timeouts.
pub fn close_all(state: &SerialState) {
    let ports: Vec<Arc<OpenPort>> = {
        let mut map = state.lock();
        map.drain().map(|(_, port)| port).collect()
    };
    for port in &ports {
        shutdown(port);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_map_to_serialport_settings() {
        assert_eq!(data_bits(None), DataBits::Eight);
        assert_eq!(data_bits(Some(7)), DataBits::Seven);
        assert_eq!(parity(Some("even")), Parity::Even);
        assert_eq!(parity(None), Parity::None);
        assert!(matches!(stop_bits(Some(2)), StopBits::Two));
        assert!(matches!(stop_bits(None), StopBits::One));
        assert!(matches!(flow_control(Some("hardware")), FlowControl::Hardware));
        assert!(matches!(flow_control(Some("none")), FlowControl::None));
    }

    #[test]
    fn dtr_and_rts_are_raised_unless_asked_otherwise() {
        assert_eq!(signal_levels(Signals::default(), false), (Some(true), Some(true)));
        assert_eq!(signal_levels(Signals::default(), true), (Some(true), None), "RTS belongs to hardware flow control");
        let low = Signals { data_terminal_ready: Some(false), request_to_send: Some(false) };
        assert_eq!(signal_levels(low, true), (Some(false), Some(false)));
    }

    #[test]
    fn macos_dial_in_twins_are_hidden() {
        let all: Vec<String> =
            ["/dev/cu.usbserial-110", "/dev/tty.usbserial-110", "/dev/tty.debug-console"].map(String::from).to_vec();
        assert!(is_dial_in_twin("/dev/tty.usbserial-110", &all));
        assert!(!is_dial_in_twin("/dev/cu.usbserial-110", &all));
        assert!(!is_dial_in_twin("/dev/tty.debug-console", &all), "no cu twin");
        assert!(!is_dial_in_twin("COM3", &all));
        assert!(!is_dial_in_twin("/dev/ttyUSB0", &all));
    }
}
