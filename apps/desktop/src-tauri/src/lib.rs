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

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
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

/// The AppImage file this run was started from, given the executable `exe` and the values of
/// `APPIMAGE` and `APPDIR`. The AppImage runtime sets both for its whole process tree, so a ubms
/// started from another AppImage (a terminal, an IDE) inherits them: the AppImage only counts when
/// the executable lies inside `APPDIR` (the mount, or the folder of `--appimage-extract-and-run`),
/// compared by whole path components. Pure, so the rule is unit tested on every platform.
fn own_appimage(exe: &Path, appimage: Option<&OsStr>, appdir: Option<&Path>) -> Option<PathBuf> {
    let image = appimage.filter(|value| !value.is_empty())?;
    // The root folder (no parent) would contain every executable.
    let dir = appdir.filter(|dir| dir.parent().is_some())?;
    exe.starts_with(dir).then(|| PathBuf::from(image))
}

/// The AppImage file of this run (Linux), or None; used by the history and plugin folders.
/// `current_exe()` resolves links, `APPDIR` may contain one (it is built from `TMPDIR`), so both
/// are made canonical before they are compared.
pub(crate) fn current_appimage(exe: &Path) -> Option<PathBuf> {
    let canonical = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let appdir = std::env::var_os("APPDIR").map(|dir| canonical(Path::new(&dir)));
    own_appimage(&canonical(exe), std::env::var_os("APPIMAGE").as_deref(), appdir.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn own(exe: &str, appimage: Option<&str>, appdir: Option<&str>) -> Option<PathBuf> {
        own_appimage(Path::new(exe), appimage.map(OsStr::new), appdir.map(Path::new))
    }

    #[test]
    fn an_appimage_counts_only_when_the_executable_is_inside_appdir() {
        let image = "/home/ann/Apps/ubms_0.1.0_amd64.AppImage";
        let mounted = "/tmp/.mount_ubmsX/usr/bin/ubms-desktop";
        assert_eq!(own(mounted, Some(image), Some("/tmp/.mount_ubmsX")), Some(PathBuf::from(image)));
        assert_eq!(own(mounted, Some(image), Some("/tmp/.mount_ubmsX/")), Some(PathBuf::from(image)), "trailing slash");
        let extracted = "/tmp/appimage_extracted_0123abcd/usr/bin/ubms-desktop";
        assert_eq!(
            own(extracted, Some(image), Some("/tmp/appimage_extracted_0123abcd")),
            Some(PathBuf::from(image)),
            "--appimage-extract-and-run"
        );
        let other = "/home/ann/Applications/Other.AppImage";
        assert_eq!(own("/usr/bin/ubms-desktop", Some(other), Some("/tmp/.mount_OtherQ")), None, "inherited from another AppImage");
        assert_eq!(own("/tmp/.mount_ubmsXy/usr/bin/ubms-desktop", Some(image), Some("/tmp/.mount_ubmsX")), None, "similar prefix");
        assert_eq!(own(mounted, Some(image), None), None, "no APPDIR");
        assert_eq!(own(mounted, Some(image), Some("")), None, "empty APPDIR");
        assert_eq!(own(mounted, Some(image), Some("/")), None, "APPDIR is the root folder");
        assert_eq!(own(mounted, None, Some("/tmp/.mount_ubmsX")), None, "no APPIMAGE");
        assert_eq!(own(mounted, Some(""), Some("/tmp/.mount_ubmsX")), None, "empty APPIMAGE");
    }
}
