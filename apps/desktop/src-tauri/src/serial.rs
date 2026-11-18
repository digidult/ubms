//! Serial port bridge on top of the serialport crate.
//!
//! Commands and events follow `docs/tauri.md`. Each open port gets a reader thread that forwards
//! bytes as soon as they arrive (10 ms read timeout), so the JavaScript framers see the same
//! stream a Web Serial reader would deliver.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter, State};

use crate::err;

/// Open ports by handle id.
#[derive(Default)]
pub struct SerialState {
    ports: Mutex<HashMap<String, OpenPort>>,
    next: AtomicU64,
}

struct OpenPort {
    writer: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
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
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Signals {
    data_terminal_ready: Option<bool>,
    request_to_send: Option<bool>,
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

#[tauri::command]
pub async fn serial_list() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(err)?;
    Ok(ports
        .into_iter()
        .map(|p| {
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
        })
        .collect())
}

fn data_bits(bits: Option<u8>) -> DataBits {
    match bits.unwrap_or(8) {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

fn parity(value: Option<&str>) -> Parity {
    match value {
        Some("even") => Parity::Even,
        Some("odd") => Parity::Odd,
        _ => Parity::None,
    }
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
) -> Result<String, String> {
    let mut port = serialport::new(&path, baud_rate)
        .data_bits(self::data_bits(data_bits))
        .stop_bits(if stop_bits == Some(2) { StopBits::Two } else { StopBits::One })
        .parity(self::parity(parity.as_deref()))
        .flow_control(if flow_control.as_deref() == Some("hardware") { FlowControl::Hardware } else { FlowControl::None })
        .timeout(Duration::from_millis(10))
        .open()
        .map_err(err)?;
    if let Some(signals) = signals {
        if let Some(level) = signals.data_terminal_ready {
            port.write_data_terminal_ready(level).map_err(err)?;
        }
        if let Some(level) = signals.request_to_send {
            port.write_request_to_send(level).map_err(err)?;
        }
    }
    let mut reader = port.try_clone().map_err(err)?;
    let handle = format!("serial-{}", state.next.fetch_add(1, Ordering::Relaxed) + 1);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let handle = handle.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while !stop.load(Ordering::Relaxed) {
                match reader.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        let _ = app.emit("serial://data", DataEvent { handle: handle.clone(), data: buf[..n].to_vec() });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        if !stop.load(Ordering::Relaxed) {
                            let _ = app.emit("serial://closed", ClosedEvent { handle: handle.clone(), reason: e.to_string() });
                        }
                        break;
                    }
                }
            }
        });
    }
    state.ports.lock().map_err(err)?.insert(handle.clone(), OpenPort { writer: port, stop });
    Ok(handle)
}

#[tauri::command]
pub async fn serial_write(state: State<'_, SerialState>, handle: String, data: Vec<u8>) -> Result<(), String> {
    let mut ports = state.ports.lock().map_err(err)?;
    let port = ports.get_mut(&handle).ok_or_else(|| "Serial port is not open".to_string())?;
    port.writer.write_all(&data).map_err(err)?;
    port.writer.flush().map_err(err)
}

#[tauri::command]
pub async fn serial_close(state: State<'_, SerialState>, handle: String) -> Result<(), String> {
    let removed = state.ports.lock().map_err(err)?.remove(&handle);
    if let Some(port) = removed {
        // The reader thread sees the flag within one read timeout and drops its handle.
        port.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
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
    }
}
