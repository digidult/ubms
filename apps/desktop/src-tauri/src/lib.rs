//! ubms desktop app.
//!
//! The window shows the unchanged ubms web app (`apps/web`, built into `dist/`). This crate only
//! adds native device access: Bluetooth Low Energy through btleplug and serial ports through
//! serialport, exposed as Tauri commands and events. The command and event contract is documented
//! in `docs/tauri.md` and consumed by `packages/transport/src/tauri.js`. The Rust side stays
//! protocol agnostic: it moves bytes, all BMS protocol logic lives in the JavaScript drivers.

mod ble;
mod serial;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ble::BleState::default())
        .manage(serial::SerialState::default())
        .invoke_handler(tauri::generate_handler![
            ble::ble_adapter_state,
            ble::ble_scan_start,
            ble::ble_scan_stop,
            ble::ble_connect,
            ble::ble_services,
            ble::ble_subscribe,
            ble::ble_unsubscribe,
            ble::ble_write,
            ble::ble_disconnect,
            serial::serial_list,
            serial::serial_open,
            serial::serial_write,
            serial::serial_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ubms desktop app");
}

/// Converts any displayable error into the string the JavaScript side receives.
pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
