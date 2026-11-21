//! ubms desktop app.
//!
//! The window shows the unchanged ubms web app (`apps/web`, built into `dist/`). This crate only
//! adds what a browser cannot do: native device access (Bluetooth Low Energy through bluest,
//! serial ports through serialport) and files (the chart history next to a portable app or in the
//! user profile, saving exports, reading plugin files from the `plugins` folder next to the app),
//! exposed as Tauri commands and events. The command and event contract is documented in
//! `docs/tauri.md` and consumed by `packages/transport/src/tauri.js`,
//! `packages/ui/src/timeseries.js` and `apps/web/src/plugins.js`. The Rust side stays protocol
//! agnostic: it moves bytes, lines and files, all BMS protocol logic lives in the JavaScript
//! drivers (built in, or loaded from plugins).

mod ble;
mod history;
mod plugins;
mod serial;

use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ble::BleState::default())
        .manage(serial::SerialState::default())
        .manage(history::HistoryState::default())
        .on_page_load(|webview, payload| {
            // A reload starts the web app from scratch: release what the previous page opened
            // (scan, Bluetooth connections, serial ports), since it can no longer close them.
            if matches!(payload.event(), PageLoadEvent::Started) {
                let app = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    release_all(&app).await;
                });
            }
        })
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
            history::history_info,
            history::history_append,
            history::history_read,
            history::history_write_meta,
            history::history_list,
            history::history_remove,
            history::history_prune,
            history::save_file,
            plugins::plugins_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the ubms desktop app");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // BlueZ keeps links made over D-Bus after the process ends, and a macOS connection
            // lingers until the system notices: disconnect explicitly, but never hang the exit.
            tauri::async_runtime::block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(4), release_all(handle)).await;
            });
        }
    });
}

/// Closes every serial port and Bluetooth connection and stops a running scan.
async fn release_all(app: &AppHandle) {
    let serial_app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        serial::close_all(&serial_app.state::<serial::SerialState>());
    })
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(3), ble::close_all(app)).await;
}

/// Converts any displayable error into the string the JavaScript side receives.
pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
