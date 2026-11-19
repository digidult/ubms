//! History storage for the Charts view, and saving exported files.
//!
//! Commands follow `docs/tauri.md` ("History storage"); `tauriFileBackend` in
//! `packages/ui/src/timeseries.js` is the JavaScript side. The module knows nothing about
//! batteries: a key is an opaque string, a record is one JSON object per line whose first member
//! is `"t"` (epoch milliseconds), which `JSON.stringify` guarantees for the records the web app
//! writes.
//!
//! - Files: `<dir>/<encoded key>.ndjson` (records) and `<dir>/<encoded key>.meta.json`. The
//!   encoding keeps `[A-Za-z0-9._-]` and writes every other UTF-8 byte as `~HH`, so a key never
//!   leaves the directory and every file name decodes back to its key.
//! - The data directory is chosen once per run: `UBMS_DATA_DIR` (tests), else next to the app
//!   (portable) or in the local app data folder of the user profile (installed), see `decide`.
//! - File work runs on the blocking thread pool. Every key has its own lock, so a long read of one
//!   device never delays the recorder of another; the map of locks is never held during I/O.
//! - Replacing a file (meta, prune) writes a temporary file next to it and renames it over the
//!   old one, so a crash leaves either the old or the new file. On Windows the rename is tried
//!   again for a moment while another program (antivirus, indexer, sync client) holds the file.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::err;

/// Overrides the data folder (tests, special setups); history goes to `<it>/history`.
const DATA_DIR_VAR: &str = "UBMS_DATA_DIR";
/// Folder next to a portable app that holds `history` and `exports`.
const PORTABLE_DIR: &str = "ubms-data";
/// A file with one of these names next to the app makes it portable, wherever it is.
const PORTABLE_MARKERS: [&str; 2] = ["portable", "ubms.portable"];
/// Written next to the app by the Tauri NSIS setup program (per-user installs go to
/// `%LOCALAPPDATA%\<product>`, per-machine installs to `%ProgramFiles%\<product>`).
const NSIS_UNINSTALLER: &str = "uninstall.exe";
/// Longest encoded key; file names stay below the usual 255 byte limit with the suffixes.
const MAX_STEM: usize = 180;
/// Longest name of a saved export, in characters.
const MAX_NAME_CHARS: usize = 120;
/// Longest extension kept when a long export name is shortened.
const MAX_EXTENSION_CHARS: usize = 16;
/// Upper bound for " (n)" when an export name is taken.
const MAX_COPIES: u32 = 9999;
/// Read and write buffer of the record files.
const BUFFER: usize = 1 << 16;
/// Bytes read from the end of a record file to find its last record (a record of 16 cells is
/// about 250 bytes).
const TAIL_BYTES: u64 = 16 * 1024;
/// Retries of a rename that Windows refuses while another program holds the target open.
const RENAME_RETRIES: u64 = 5;

/// History state managed by Tauri.
#[derive(Default)]
pub struct HistoryState {
    /// Resolved on first use and kept for the whole run.
    location: Mutex<Option<Location>>,
    /// One lock per key. The map itself is only held to look a lock up, never during I/O.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl HistoryState {
    /// The data location; resolved once (runs on the blocking pool, the probe touches the disk).
    fn location(&self, app: &AppHandle) -> Result<Location, String> {
        let mut slot = self.location.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(location) = slot.as_ref() {
            return Ok(location.clone());
        }
        let location = resolve_location(app)?;
        *slot = Some(location.clone());
        Ok(location)
    }

    fn key_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(PoisonError::into_inner);
        locks.entry(key.to_string()).or_default().clone()
    }
}

/// Where history and exports live during this run.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Location {
    history: PathBuf,
    exports: PathBuf,
    portable: bool,
    reason: String,
}

impl Location {
    fn new(root: PathBuf, portable: bool, reason: String) -> Self {
        Location { history: root.join("history"), exports: root.join("exports"), portable, reason }
    }
}

/// Result of `history_info`.
#[derive(Serialize)]
pub struct Info {
    dir: String,
    portable: bool,
    /// Which rule chose the folder, in English (shown in the app and useful in bug reports).
    reason: String,
}

/// One stored key, as listed by `history_list`.
#[derive(Serialize, Debug, PartialEq)]
pub struct Stored {
    key: String,
    meta: Option<String>,
    /// Size of the record file (0 when only the meta file exists).
    bytes: u64,
    /// Last change of the record file, epoch milliseconds; of the meta file when there is no
    /// record file. The app rewrites the meta on every connect, so it does not count otherwise.
    modified: u64,
    /// Time `t` of the newest record among the last lines of the record file, or None (no record
    /// file, or no complete record at its end).
    last: Option<i64>,
}

// ----- Data folder: portable or installed --------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Os {
    Windows,
    MacOs,
    /// Linux and every other Unix.
    Linux,
}

impl Os {
    fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// What the portable rule looks at. Collected by `resolve_location`, so `decide` stays pure and
/// testable on every platform (paths are plain strings in the syntax of `os`).
struct Facts<'a> {
    os: Os,
    /// Path of the running executable.
    exe: &'a str,
    /// Linux: started from an AppImage (`APPIMAGE` set); the base folder is the AppImage's.
    appimage: bool,
    /// Linux: running inside a Flatpak (`FLATPAK_ID` set).
    flatpak: bool,
    /// Windows install folders from the environment (ProgramFiles, LocalAppData and so on).
    install_roots: &'a [String],
    /// A `portable` or `ubms.portable` file is in the base folder.
    marker: bool,
    /// Windows: the NSIS uninstaller is next to the executable.
    uninstaller: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct Decision {
    portable: bool,
    reason: String,
}

impl Decision {
    fn portable(reason: &str) -> Self {
        Decision { portable: true, reason: reason.to_string() }
    }

    fn installed(reason: &str) -> Self {
        Decision { portable: false, reason: reason.to_string() }
    }
}

/// The portable rule. A marker file always wins; an AppImage is portable when its folder is
/// writable; otherwise an app in an install location is installed, and an app elsewhere is
/// portable when its folder is writable. `writable` probes the base folder and is only called
/// when the answer depends on it.
fn decide(facts: &Facts, writable: impl FnOnce() -> bool) -> Decision {
    if facts.marker {
        return Decision::portable("A file named portable or ubms.portable is next to the app");
    }
    if facts.appimage {
        return if writable() {
            Decision::portable("AppImage: the data folder is next to the AppImage file")
        } else {
            Decision::installed("The folder of the AppImage file is not writable")
        };
    }
    if let Some(reason) = install_location(facts) {
        return Decision { portable: false, reason };
    }
    if writable() {
        Decision::portable("The app folder is writable and not an install location")
    } else {
        Decision::installed("The app folder is not writable")
    }
}

/// Why the executable counts as installed, or None.
fn install_location(facts: &Facts) -> Option<String> {
    match facts.os {
        Os::Windows => {
            if facts.uninstaller {
                return Some("An uninstaller is next to the app (installed by the setup program)".to_string());
            }
            facts
                .install_roots
                .iter()
                .find(|root| within(facts.exe, root.as_str(), Os::Windows))
                .map(|root| format!("The app is in an install location ({root})"))
        }
        Os::MacOs => {
            if facts.exe.split('/').any(|part| part.to_ascii_lowercase().ends_with(".app")) {
                Some("The app runs from a macOS app bundle".to_string())
            } else if within(facts.exe, "/Applications", Os::MacOs) {
                Some("The app is in an install location (/Applications)".to_string())
            } else {
                None
            }
        }
        Os::Linux => {
            if facts.flatpak {
                return Some("The app runs as a Flatpak".to_string());
            }
            ["/usr", "/opt", "/snap"]
                .into_iter()
                .find(|root| within(facts.exe, root, Os::Linux))
                .map(|root| format!("The app is in an install location ({root})"))
        }
    }
}

/// Removes the verbatim prefix Windows sometimes reports (`\\?\C:\...`, `\\?\UNC\server\...`).
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// Comparable form of a path: Windows paths are case-insensitive and accept both slashes.
fn normalize(path: &str, os: Os) -> String {
    match os {
        Os::Windows => strip_verbatim(&path.replace('/', "\\")).trim_end_matches('\\').to_lowercase(),
        Os::MacOs | Os::Linux => path.trim_end_matches('/').to_string(),
    }
}

/// True when `path` is `root` or inside it (whole components only: /usrlocal is not in /usr).
fn within(path: &str, root: &str, os: Os) -> bool {
    let separator = if os == Os::Windows { '\\' } else { '/' };
    let path = normalize(path, os);
    let root = normalize(root, os);
    if root.is_empty() {
        return false;
    }
    path == root || (path.starts_with(&root) && path[root.len()..].starts_with(separator))
}

/// Windows install folders. The whole of `%LOCALAPPDATA%` counts: the Tauri NSIS setup installs
/// per user into `%LOCALAPPDATA%\<product>`, other setups use `%LOCALAPPDATA%\Programs`, and an exe
/// started straight from a zip file runs from `%LOCALAPPDATA%\Temp`, where data would get lost.
fn install_roots(os: Os) -> Vec<String> {
    if os != Os::Windows {
        return Vec::new();
    }
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string_lossy().into_owned())
        .collect()
}

/// Probes a folder by creating and deleting a file in it.
fn dir_writable(dir: &Path) -> bool {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let probe = dir.join(format!(".ubms-write-test-{}-{nanos}", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn resolve_location(app: &AppHandle) -> Result<Location, String> {
    if let Some(dir) = std::env::var_os(DATA_DIR_VAR).filter(|value| !value.is_empty()) {
        let reason = format!("The {DATA_DIR_VAR} environment variable sets the data folder");
        return Ok(Location::new(PathBuf::from(dir), false, reason));
    }
    let os = Os::current();
    let exe = std::env::current_exe().map_err(err)?;
    let appimage = match os {
        Os::Linux => std::env::var_os("APPIMAGE").filter(|value| !value.is_empty()).map(PathBuf::from),
        Os::Windows | Os::MacOs => None,
    };
    let base: Option<PathBuf> = appimage
        .as_deref()
        .unwrap_or(exe.as_path())
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf);
    let decision = match &base {
        Some(base) => {
            let exe_text = exe.to_string_lossy();
            let roots = install_roots(os);
            let facts = Facts {
                os,
                exe: &*exe_text,
                appimage: appimage.is_some(),
                flatpak: std::env::var_os("FLATPAK_ID").is_some_and(|value| !value.is_empty()),
                install_roots: &roots,
                marker: PORTABLE_MARKERS.iter().any(|name| base.join(name).is_file()),
                uninstaller: os == Os::Windows && base.join(NSIS_UNINSTALLER).is_file(),
            };
            decide(&facts, || dir_writable(base))
        }
        None => Decision::installed("The folder of the app is unknown"),
    };
    match base {
        Some(base) if decision.portable => Ok(Location::new(base.join(PORTABLE_DIR), true, decision.reason)),
        _ => {
            // The local (not roaming) folder: Windows copies a roaming profile at every logon and
            // logoff, which history files of tens of MB would slow down. Same folder as
            // app_data_dir() on macOS and Linux.
            let data = app.path().app_local_data_dir().map_err(err)?;
            Ok(Location::new(data, false, decision.reason))
        }
    }
}

// ----- Keys and file names -----------------------------------------------------------------------

const HEX: &[u8; 16] = b"0123456789ABCDEF";

fn is_plain(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

fn push_escaped(out: &mut String, byte: u8) {
    out.push('~');
    out.push(char::from(HEX[usize::from(byte >> 4)]));
    out.push(char::from(HEX[usize::from(byte & 0x0F)]));
}

/// Windows refuses device names as file names, even with an extension (CON.ndjson).
fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit(),
    }
}

/// File name stem of a key: `[A-Za-z0-9._-]` stays, every other UTF-8 byte becomes `~HH`. A stem
/// that Windows would read as a device name gets its first character escaped as well, so a
/// portable data folder works on every system; decoding is the same either way.
fn encode_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for &byte in key.as_bytes() {
        if is_plain(byte) {
            out.push(char::from(byte));
        } else {
            push_escaped(&mut out, byte);
        }
    }
    if is_reserved_name(&out) {
        let mut escaped = String::with_capacity(out.len() + 2);
        push_escaped(&mut escaped, out.as_bytes()[0]);
        escaped.push_str(&out[1..]);
        out = escaped;
    }
    out
}

fn hex_value(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        _ => digit - b'A' + 10,
    }
}

/// The key of a file name stem, or None when the stem is not an encoded key.
fn decode_key(stem: &str) -> Option<String> {
    let bytes = stem.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'~' => {
                let pair = bytes.get(i + 1..i + 3)?;
                if !pair.iter().all(u8::is_ascii_hexdigit) {
                    return None;
                }
                out.push((hex_value(pair[0]) << 4) | hex_value(pair[1]));
                i += 3;
            }
            byte if is_plain(byte) => {
                out.push(byte);
                i += 1;
            }
            _ => return None,
        }
    }
    String::from_utf8(out).ok()
}

fn file_stem(key: &str) -> Result<String, String> {
    if key.is_empty() {
        return Err("History key is empty".to_string());
    }
    let stem = encode_key(key);
    if stem.len() > MAX_STEM {
        return Err("History key is too long".to_string());
    }
    Ok(stem)
}

fn data_path(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}.ndjson"))
}

fn meta_path(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}.meta.json"))
}

/// `<file>.tmp-<pid>` next to the file (same volume, so the rename is atomic).
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".tmp-{}", std::process::id()));
    path.with_file_name(name)
}

// ----- Records -----------------------------------------------------------------------------------

fn has_line_break(line: &str) -> bool {
    line.bytes().any(|b| b == b'\r' || b == b'\n')
}

/// The time of a stored record: a record line starts with `{"t":<integer>` followed by `,` or
/// `}`, and ends with `}` (a line cut short by a crash does not).
fn line_time(line: &str) -> Option<i64> {
    let rest = line.strip_prefix("{\"t\":")?;
    if !rest.ends_with('}') {
        return None;
    }
    let digits = rest.strip_prefix('-').unwrap_or(rest);
    let count = digits.bytes().take_while(u8::is_ascii_digit).count();
    if count == 0 || !matches!(digits.as_bytes().get(count), Some(b',' | b'}')) {
        return None;
    }
    rest[..rest.len() - digits.len() + count].parse().ok()
}

/// `[from, to]`, a missing bound is open.
fn in_range(t: i64, from: Option<f64>, to: Option<f64>) -> bool {
    let t = t as f64;
    from.is_none_or(|from| t >= from) && to.is_none_or(|to| t <= to)
}

/// One line without its line break, or None for bytes that are not UTF-8.
fn text_line(raw: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(raw).ok()?;
    Some(text.trim_end_matches(|c: char| c == '\n' || c == '\r'))
}

/// Time of the newest record among the last lines of a record file (the last `TAIL_BYTES`), or
/// None when there is none there or the file cannot be read. Records are appended in time order,
/// so this is the time of the last record unless the computer clock went back.
fn last_record_time(path: &Path) -> Option<i64> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let mut lines = tail.split(|&byte| byte == b'\n');
    if start > 0 {
        // The first piece may be the end of a line that started before the tail.
        lines.next();
    }
    lines.filter_map(text_line).filter_map(line_time).max()
}

fn read_records(path: &Path, from: Option<f64>, to: Option<f64>) -> io::Result<Vec<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut reader = BufReader::with_capacity(BUFFER, file);
    let mut raw = Vec::new();
    let mut lines = Vec::new();
    loop {
        raw.clear();
        if reader.read_until(b'\n', &mut raw)? == 0 {
            break;
        }
        if let Some(line) = text_line(&raw) {
            if line_time(line).is_some_and(|t| in_range(t, from, to)) {
                lines.push(line.to_string());
            }
        }
    }
    Ok(lines)
}

/// True when the file does not end with a line break (an earlier write was cut short): the next
/// record then has to start on a line of its own.
fn ends_open(file: &mut File) -> io::Result<bool> {
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(len - 1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

/// Appends the lines (callers reject line breaks first); empty lines are skipped.
fn append_records(path: &Path, lines: &[String]) -> io::Result<()> {
    let mut text = String::new();
    for line in lines.iter().filter(|line| !line.is_empty()) {
        text.push_str(line);
        text.push('\n');
    }
    if text.is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    // Append mode: every write lands at the end of the file, whatever the read position.
    let mut file = OpenOptions::new().read(true).append(true).create(true).open(path)?;
    if ends_open(&mut file)? {
        text.insert(0, '\n');
    }
    file.write_all(text.as_bytes())?;
    file.flush()
}

fn write_synced(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(data)?;
    file.sync_all()
}

/// Windows refuses to replace a file that another program holds open without delete sharing
/// (antivirus, the search indexer, OneDrive and other sync clients, which often watch a portable
/// folder): access denied (os error 5) or a sharing violation (32, 33). Such locks are usually
/// released within moments. Elsewhere these errors are permanent.
fn is_transient_lock(e: &io::Error) -> bool {
    cfg!(windows) && (e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33)))
}

/// `fs::rename`, tried again up to `RENAME_RETRIES` times (after 50, 100, 150, 200 and 250 ms)
/// while Windows reports the target as locked. The callers run on the blocking thread pool, so
/// sleeping is fine.
fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut retry: u64 = 0;
    loop {
        match fs::rename(from, to) {
            Err(e) if retry < RENAME_RETRIES && is_transient_lock(&e) => {
                retry += 1;
                std::thread::sleep(Duration::from_millis(50 * retry));
            }
            result => return result,
        }
    }
}

/// Writes a temporary file next to `path` and renames it over `path`.
fn replace_file(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = temp_path(path);
    let written = write_synced(&temp, data).and_then(|()| rename_retry(&temp, path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Copies the records with `t >= before` into `target` and returns how many lines it left out:
/// older records and lines that are not records (cut short by a crash). Empty lines are dropped
/// without being counted.
fn copy_newer(source: File, target: &Path, before: f64) -> io::Result<u64> {
    let mut reader = BufReader::with_capacity(BUFFER, source);
    let mut writer = BufWriter::with_capacity(BUFFER, File::create(target)?);
    let mut raw = Vec::new();
    let mut removed = 0u64;
    loop {
        raw.clear();
        if reader.read_until(b'\n', &mut raw)? == 0 {
            break;
        }
        let Some(line) = text_line(&raw) else {
            removed += 1;
            continue;
        };
        if line.is_empty() {
            continue;
        }
        match line_time(line) {
            Some(t) if t as f64 >= before => {
                writer.write_all(line.as_bytes())?;
                writer.write_all(b"\n")?;
            }
            _ => removed += 1,
        }
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(removed)
}

/// Rewrites the file without the records older than `before`; returns the number of removed
/// lines. Nothing is rewritten when nothing is removed.
fn prune_records(path: &Path, before: f64) -> io::Result<u64> {
    let source = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let temp = temp_path(path);
    // copy_newer consumes the source, so it is closed before the rename (needed on Windows).
    let removed = match copy_newer(source, &temp, before) {
        Ok(removed) => removed,
        Err(e) => {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
    };
    if removed == 0 {
        let _ = fs::remove_file(&temp);
        return Ok(0);
    }
    if let Err(e) = rename_retry(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    Ok(removed)
}

fn epoch_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// A key found while listing, with the change times of its record and meta file.
struct Found {
    stored: Stored,
    data_modified: Option<u64>,
    meta_modified: Option<u64>,
}

/// Every key with a record or meta file, most recently changed first. Files whose name is not an
/// encoded key (temporary files, foreign files) are ignored.
fn list_keys(dir: &Path) -> io::Result<Vec<Stored>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut found: BTreeMap<String, Found> = BTreeMap::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else { continue };
        let (stem, is_meta) = match (name.strip_suffix(".meta.json"), name.strip_suffix(".ndjson")) {
            (Some(stem), _) => (stem, true),
            (None, Some(stem)) => (stem, false),
            (None, None) => continue,
        };
        let Some(key) = decode_key(stem) else { continue };
        if file_stem(&key).ok().as_deref() != Some(stem) {
            continue;
        }
        // From the file itself: on Windows the directory entry can show an older size and time.
        let Ok(metadata) = fs::metadata(entry.path()) else { continue };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().ok().map_or(0, epoch_ms);
        let item = found.entry(key.clone()).or_insert_with(|| Found {
            stored: Stored { key, meta: None, bytes: 0, modified: 0, last: None },
            data_modified: None,
            meta_modified: None,
        });
        if is_meta {
            item.stored.meta = fs::read_to_string(entry.path()).ok();
            item.meta_modified = Some(modified);
        } else {
            item.stored.bytes = metadata.len();
            item.stored.last = last_record_time(&entry.path());
            item.data_modified = Some(modified);
        }
    }
    let mut list: Vec<Stored> = found
        .into_values()
        .map(|item| Stored { modified: item.data_modified.or(item.meta_modified).unwrap_or(0), ..item.stored })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.key.cmp(&b.key)));
    Ok(list)
}

/// Removes the record and meta files; missing files are fine.
fn remove_files(dir: &Path, stem: &str) -> io::Result<()> {
    for path in [data_path(dir, stem), meta_path(dir, stem)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

// ----- Saving exports ----------------------------------------------------------------------------

/// Standard base64 (RFC 4648) as `btoa` writes it; the URL-safe alphabet, missing padding and
/// ASCII white space are accepted as well.
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    const INVALID: &str = "The file data is not valid base64";
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = 0usize;
    for &byte in text.as_bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => {
                padding += 1;
                continue;
            }
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            _ => return Err(INVALID.to_string()),
        };
        if padding > 0 {
            return Err(INVALID.to_string());
        }
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Six bits left means a group with a single character, which cannot encode a byte.
    if padding > 2 || bits >= 6 {
        return Err(INVALID.to_string());
    }
    Ok(out)
}

/// `name.ext` -> (`name`, `.ext`); a leading dot is not an extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// A file name that every system accepts: the last path component only, without characters
/// Windows refuses, without leading or trailing dots and spaces, not a device name, and at most
/// `MAX_NAME_CHARS` characters (the extension is kept).
fn safe_file_name(name: &str) -> String {
    let trim = |c: char| c == ' ' || c == '.';
    let base = name.rsplit(|c: char| c == '/' || c == '\\').next().unwrap_or_default();
    let cleaned: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let mut name = cleaned.trim_matches(trim).to_string();
    if name.chars().count() > MAX_NAME_CHARS {
        let (stem, extension) = split_extension(&name);
        let extension = if extension.chars().count() <= MAX_EXTENSION_CHARS { extension } else { "" };
        let keep = MAX_NAME_CHARS - extension.chars().count();
        name = stem.chars().take(keep).collect::<String>() + extension;
        name = name.trim_end_matches(trim).to_string();
    }
    if name.is_empty() {
        name = "export".to_string();
    }
    if is_reserved_name(&name) {
        name.insert(0, '_');
    }
    name
}

/// Writes `data` to `dir/name`, or to `name (2).ext`, `name (3).ext` and so on when the name is
/// taken. `create_new` makes the check and the creation one step.
fn write_unique(dir: &Path, name: &str, data: &[u8]) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let (stem, extension) = split_extension(name);
    for n in 1..=MAX_COPIES {
        let candidate = if n == 1 { name.to_string() } else { format!("{stem} ({n}){extension}") };
        let path = dir.join(candidate);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if let Err(e) = file.write_all(data).and_then(|()| file.flush()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(e);
        }
        return Ok(path);
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "Too many files with this name"))
}

// ----- Commands ----------------------------------------------------------------------------------

/// Runs file work on the blocking thread pool with the managed state.
async fn blocking<T, F>(app: AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&HistoryState, &AppHandle) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HistoryState>();
        work(state.inner(), &app)
    })
    .await
    .map_err(err)?
}

/// Runs `work` on the history folder and the file stem of `key`, holding the key's lock.
fn with_key<T>(
    state: &HistoryState,
    app: &AppHandle,
    key: &str,
    work: impl FnOnce(&Path, &str) -> io::Result<T>,
) -> Result<T, String> {
    let stem = file_stem(key)?;
    let dir = state.location(app)?.history;
    let lock = state.key_lock(key);
    let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
    work(&dir, &stem).map_err(err)
}

#[tauri::command]
pub async fn history_info(app: AppHandle) -> Result<Info, String> {
    blocking(app, |state, app| {
        let location = state.location(app)?;
        Ok(Info { dir: location.history.display().to_string(), portable: location.portable, reason: location.reason })
    })
    .await
}

#[tauri::command]
pub async fn history_append(app: AppHandle, key: String, lines: Vec<String>) -> Result<(), String> {
    if let Some(index) = lines.iter().position(|line| has_line_break(line)) {
        return Err(format!("History line {} contains a line break", index + 1));
    }
    blocking(app, move |state, app| {
        with_key(state, app, &key, |dir, stem| append_records(&data_path(dir, stem), &lines))
    })
    .await
}

#[tauri::command]
pub async fn history_read(app: AppHandle, key: String, from: Option<f64>, to: Option<f64>) -> Result<Vec<String>, String> {
    blocking(app, move |state, app| {
        with_key(state, app, &key, |dir, stem| read_records(&data_path(dir, stem), from, to))
    })
    .await
}

#[tauri::command]
pub async fn history_write_meta(app: AppHandle, key: String, meta: String) -> Result<(), String> {
    blocking(app, move |state, app| {
        with_key(state, app, &key, |dir, stem| replace_file(&meta_path(dir, stem), meta.as_bytes()))
    })
    .await
}

#[tauri::command]
pub async fn history_list(app: AppHandle) -> Result<Vec<Stored>, String> {
    blocking(app, |state, app| {
        let dir = state.location(app)?.history;
        list_keys(&dir).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn history_remove(app: AppHandle, key: String) -> Result<(), String> {
    blocking(app, move |state, app| with_key(state, app, &key, remove_files)).await
}

#[tauri::command]
pub async fn history_prune(app: AppHandle, key: String, before: f64) -> Result<u64, String> {
    blocking(app, move |state, app| {
        with_key(state, app, &key, |dir, stem| prune_records(&data_path(dir, stem), before))
    })
    .await
}

/// Saves an export (CSV, PNG) into the Downloads folder, or into `<data folder>/exports` when
/// there is no Downloads folder or it cannot be written. Returns the absolute path.
#[tauri::command]
pub async fn save_file(app: AppHandle, name: String, data: String) -> Result<String, String> {
    blocking(app, move |state, app| {
        let bytes = decode_base64(&data)?;
        let name = safe_file_name(&name);
        let downloads = app.path().download_dir().ok().filter(|dir| dir.is_dir());
        let exports = state.location(app).ok().map(|location| location.exports);
        let mut failures = Vec::new();
        for dir in [downloads, exports].into_iter().flatten() {
            match write_unique(&dir, &name, &bytes) {
                Ok(path) => return Ok(std::path::absolute(&path).unwrap_or(path).display().to_string()),
                Err(e) => failures.push(format!("{}: {e}", dir.display())),
            }
        }
        if failures.is_empty() {
            failures.push("no folder to save into".to_string());
        }
        Err(format!("Could not save {name}: {}", failures.join("; ")))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder in the system temp folder, unique per test and process.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ubms-history-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn facts<'a>(os: Os, exe: &'a str, roots: &'a [String]) -> Facts<'a> {
        Facts { os, exe, appimage: false, flatpak: false, install_roots: roots, marker: false, uninstaller: false }
    }

    fn windows_roots() -> Vec<String> {
        [r"C:\Program Files", r"C:\Program Files (x86)", r"C:\ProgramData", r"C:\Users\Ann\AppData\Local"]
            .map(String::from)
            .to_vec()
    }

    #[test]
    fn keys_encode_to_safe_file_names_and_back() {
        assert_eq!(encode_key("sn:jk:ABC-123_x.y"), "sn~3Ajk~3AABC-123_x.y");
        assert_eq!(encode_key("serial:/dev/ttyUSB0"), "serial~3A~2Fdev~2FttyUSB0");
        assert_eq!(encode_key("name:jk:B\u{e4}r 1"), "name~3Ajk~3AB~C3~A4r~201");
        assert_eq!(encode_key("../../etc"), "..~2F..~2Fetc", "no separator survives");
        for key in [
            "sn:jk:ABC-123_x.y",
            "ble:BluetoothLE#BluetoothLE00:1a:7d:da:71:13-c8:47:8c:10:20:30",
            r"serial:\\.\COM7",
            "name:jk:B\u{e4}r 1",
            "~",
            ".",
        ] {
            assert_eq!(decode_key(&encode_key(key)).as_deref(), Some(key), "{key}");
        }
    }

    #[test]
    fn windows_device_names_are_escaped() {
        assert_eq!(encode_key("CON"), "~43ON");
        assert_eq!(encode_key("nul.x"), "~6Eul.x");
        assert_eq!(encode_key("com1"), "~63om1");
        assert_eq!(encode_key("LPT9.log"), "~4CPT9.log");
        assert_eq!(encode_key("COMX"), "COMX");
        assert_eq!(encode_key("CONSOLE"), "CONSOLE");
        for key in ["CON", "nul.x", "com1"] {
            assert_eq!(decode_key(&encode_key(key)).as_deref(), Some(key));
        }
    }

    #[test]
    fn foreign_stems_do_not_decode() {
        assert_eq!(decode_key("a~4"), None, "cut escape");
        assert_eq!(decode_key("a~zz"), None, "not hex");
        assert_eq!(decode_key("a~+F"), None, "sign is not a hex digit");
        assert_eq!(decode_key("a b"), None, "plain space");
        assert_eq!(decode_key("~FF"), None, "not UTF-8");
        assert_eq!(decode_key("sn~3ajk").as_deref(), Some("sn:jk"), "lowercase hex decodes");
        assert_ne!(encode_key("sn:jk"), "sn~3ajk", "but is not canonical, so history_list skips it");
    }

    #[test]
    fn empty_and_long_keys_are_refused() {
        assert!(file_stem("").is_err());
        assert!(file_stem(&"x".repeat(MAX_STEM + 1)).is_err());
        assert!(file_stem(&":".repeat(MAX_STEM / 3)).is_ok());
        assert!(file_stem(&":".repeat(MAX_STEM / 3 + 1)).is_err(), "the encoded length counts");
    }

    #[test]
    fn record_lines_are_recognised_by_their_leading_time() {
        assert_eq!(line_time(r#"{"t":1700000000000,"u":53.1,"c":[3.3,3.31]}"#), Some(1_700_000_000_000));
        assert_eq!(line_time(r#"{"t":12}"#), Some(12));
        assert_eq!(line_time(r#"{"t":-5,"u":1}"#), Some(-5));
        assert_eq!(line_time(r#"{"t":1.5,"u":1}"#), None, "not an integer");
        assert_eq!(line_time(r#"{"u":1,"t":5}"#), None, "t is not first");
        assert_eq!(line_time(r#"{"t":"5"}"#), None);
        assert_eq!(line_time(r#"{"t":123,"u":5"#), None, "cut short");
        assert_eq!(line_time(r#"{ "t":1}"#), None);
        assert_eq!(line_time(r#"{"t":}"#), None);
        assert_eq!(line_time(r#"{"t":-}"#), None);
        assert_eq!(line_time(""), None);
    }

    #[test]
    fn ranges_include_both_bounds_and_missing_bounds_are_open() {
        assert!(in_range(5, Some(5.0), Some(5.0)));
        assert!(!in_range(4, Some(5.0), None));
        assert!(!in_range(6, None, Some(5.0)));
        assert!(in_range(i64::MIN, None, None));
    }

    #[test]
    fn line_breaks_are_detected() {
        assert!(has_line_break("{\"t\":1}\n"));
        assert!(has_line_break("{\"t\":1}\r"));
        assert!(!has_line_break("{\"t\":1,\"n\":\"a\\nb\"}"), "an escaped \\n inside JSON is fine");
    }

    #[test]
    fn paths_compare_by_whole_components() {
        let w = Os::Windows;
        assert!(within(r"C:\Program Files\ubms\ubms.exe", r"C:\Program Files", w));
        assert!(within(r"c:/program files/ubms/ubms.exe", r"C:\Program Files\", w));
        assert!(within(r"\\?\C:\Program Files\ubms\ubms.exe", r"C:\Program Files", w));
        assert!(within(r"\\?\UNC\srv\apps\ubms.exe", r"\\srv\apps", w));
        assert!(!within(r"C:\Program Files (x86)\ubms.exe", r"C:\Program Files", w));
        assert!(!within(r"D:\Tools\ubms.exe", "", w));
        let l = Os::Linux;
        assert!(within("/usr/bin/ubms", "/usr", l));
        assert!(within("/opt", "/opt/", l));
        assert!(!within("/usrlocal/ubms", "/usr", l));
        assert!(!within("/home/ann/usr/ubms", "/usr", l));
        assert!(!within("/USR/bin/ubms", "/usr", l), "case matters on Linux");
        assert!(!within("/usr/bin/ubms", "/", l));
    }

    #[test]
    fn windows_install_locations_are_not_portable() {
        let roots = windows_roots();
        let never = || -> bool { panic!("no write probe for an install location") };
        for exe in [
            r"C:\Program Files\ubms\ubms-desktop.exe",
            r"C:\Program Files (x86)\ubms\ubms-desktop.exe",
            r"C:\Users\Ann\AppData\Local\ubms\ubms-desktop.exe",
            r"C:\Users\Ann\AppData\Local\Programs\ubms\ubms-desktop.exe",
            r"C:\Users\Ann\AppData\Local\Temp\Temp1_ubms.zip\ubms-desktop.exe",
            r"c:\programdata\ubms\ubms-desktop.exe",
        ] {
            let decision = decide(&facts(Os::Windows, exe, &roots), never);
            assert!(!decision.portable, "{exe}");
            assert!(decision.reason.contains("install location"), "{exe}: {}", decision.reason);
        }
        let mut installed = facts(Os::Windows, r"D:\Apps\ubms\ubms-desktop.exe", &roots);
        installed.uninstaller = true;
        assert!(!decide(&installed, never).portable, "the NSIS uninstaller marks a custom install folder");
    }

    #[test]
    fn windows_elsewhere_is_portable_when_writable() {
        let roots = windows_roots();
        let exe = r"D:\Tools\ubms\ubms-desktop.exe";
        assert!(decide(&facts(Os::Windows, exe, &roots), || true).portable);
        let read_only = decide(&facts(Os::Windows, exe, &roots), || false);
        assert_eq!(read_only, Decision::installed("The app folder is not writable"));
        let downloads = r"C:\Users\Ann\Downloads\ubms-desktop.exe";
        assert!(decide(&facts(Os::Windows, downloads, &roots), || true).portable);
    }

    #[test]
    fn a_marker_file_always_makes_the_app_portable() {
        let roots = windows_roots();
        let mut marked = facts(Os::Windows, r"C:\Program Files\ubms\ubms-desktop.exe", &roots);
        marked.marker = true;
        marked.uninstaller = true;
        let decision = decide(&marked, || false);
        assert!(decision.portable);
        assert!(decision.reason.contains("portable"));
    }

    #[test]
    fn macos_bundles_and_applications_are_installed() {
        let none: Vec<String> = Vec::new();
        let never = || -> bool { panic!("no write probe") };
        for exe in [
            "/Applications/ubms.app/Contents/MacOS/ubms-desktop",
            "/Users/ann/Downloads/ubms.app/Contents/MacOS/ubms-desktop",
            "/Users/ann/Downloads/UBMS.APP/Contents/MacOS/ubms-desktop",
            "/Applications/ubms-desktop",
        ] {
            assert!(!decide(&facts(Os::MacOs, exe, &none), never).portable, "{exe}");
        }
        assert!(decide(&facts(Os::MacOs, "/Users/ann/tools/ubms-desktop", &none), || true).portable);
    }

    #[test]
    fn linux_system_folders_flatpak_and_appimage() {
        let none: Vec<String> = Vec::new();
        let never = || -> bool { panic!("no write probe") };
        for exe in ["/usr/bin/ubms-desktop", "/opt/ubms/ubms-desktop", "/snap/ubms/12/usr/bin/ubms-desktop"] {
            assert!(!decide(&facts(Os::Linux, exe, &none), never).portable, "{exe}");
        }
        let mut flatpak = facts(Os::Linux, "/app/bin/ubms-desktop", &none);
        flatpak.flatpak = true;
        assert_eq!(decide(&flatpak, never), Decision::installed("The app runs as a Flatpak"));
        // An AppImage runs from a mount under /tmp; its own folder decides.
        let mut appimage = facts(Os::Linux, "/tmp/.mount_ubmsAb12/usr/bin/ubms-desktop", &none);
        appimage.appimage = true;
        assert!(decide(&appimage, || true).portable);
        assert!(!decide(&appimage, || false).portable);
        assert!(decide(&facts(Os::Linux, "/home/ann/apps/ubms-desktop", &none), || true).portable);
        assert!(!decide(&facts(Os::Linux, "/home/ann/apps/ubms-desktop", &none), || false).portable);
    }

    #[test]
    fn records_append_read_prune_list_and_remove() {
        let dir = temp_dir("store");
        let stem = file_stem("sn:jk:A1").unwrap();
        let data = data_path(&dir, &stem);
        let lines: Vec<String> = (1..=5).map(|t| format!("{{\"t\":{t}000,\"u\":53.{t}}}")).collect();
        assert_eq!(lines[0], r#"{"t":1000,"u":53.1}"#);
        append_records(&data, &lines[..3]).unwrap(); // creates the folder
        append_records(&data, &lines[3..]).unwrap();
        append_records(&data, &[]).unwrap();
        assert_eq!(read_records(&data, None, None).unwrap(), lines);
        assert_eq!(read_records(&data, Some(2000.0), Some(4000.0)).unwrap(), lines[1..4].to_vec());
        assert_eq!(read_records(&data, Some(4500.0), None).unwrap(), lines[4..].to_vec());
        assert_eq!(read_records(&data, None, Some(999.0)).unwrap(), Vec::<String>::new());

        replace_file(&meta_path(&dir, &stem), br#"{"name":"JK"}"#).unwrap();
        replace_file(&meta_path(&dir, &stem), br#"{"name":"JK B2A"}"#).unwrap();
        let list = list_keys(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "sn:jk:A1");
        assert_eq!(list[0].meta.as_deref(), Some(r#"{"name":"JK B2A"}"#));
        assert_eq!(list[0].bytes, fs::metadata(&data).unwrap().len());
        assert_eq!(list[0].last, Some(5000), "the time of the last record");
        // The meta file is newer (written on every connect); the record file's time counts.
        let older = UNIX_EPOCH + Duration::from_millis(1_700_000_000_000);
        File::options().write(true).open(&data).unwrap().set_modified(older).unwrap();
        assert_eq!(list_keys(&dir).unwrap()[0].modified, 1_700_000_000_000);

        assert_eq!(prune_records(&data, 3000.0).unwrap(), 2);
        assert_eq!(read_records(&data, None, None).unwrap(), lines[2..].to_vec());
        assert_eq!(prune_records(&data, 3000.0).unwrap(), 0, "nothing older left");

        remove_files(&dir, &stem).unwrap();
        remove_files(&dir, &stem).unwrap(); // missing files are fine
        assert!(list_keys(&dir).unwrap().is_empty());
        assert_eq!(read_records(&data, None, None).unwrap(), Vec::<String>::new());
        assert_eq!(prune_records(&data, 1.0).unwrap(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_line_cut_short_does_not_spoil_the_next_record() {
        let dir = temp_dir("cut");
        fs::create_dir_all(&dir).unwrap();
        let data = dir.join("k.ndjson");
        fs::write(&data, "{\"t\":1,\"u\":1}\r\n{\"t\":2,\"u\"").unwrap();
        append_records(&data, &[r#"{"t":3,"u":3}"#.to_string()]).unwrap();
        assert_eq!(read_records(&data, None, None).unwrap(), vec![r#"{"t":1,"u":1}"#, r#"{"t":3,"u":3}"#]);
        assert_eq!(prune_records(&data, 0.0).unwrap(), 1, "the cut line is dropped");
        assert_eq!(fs::read_to_string(&data).unwrap(), "{\"t\":1,\"u\":1}\n{\"t\":3,\"u\":3}\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn listing_skips_files_that_are_not_keys() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("sub.ndjson")).unwrap();
        for name in ["notes.txt", "Foo~41.ndjson", "x.ndjson.tmp-1", "bad name.ndjson"] {
            fs::write(dir.join(name), "{\"t\":1}\n").unwrap();
        }
        let stem = file_stem("name:ant:ANT-BLE16").unwrap();
        replace_file(&meta_path(&dir, &stem), b"{}").unwrap();
        let list = list_keys(&dir).unwrap();
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(list[0].key, "name:ant:ANT-BLE16");
        assert_eq!(list[0].bytes, 0, "meta only");
        assert_eq!(list[0].last, None, "no records");
        assert!(list[0].modified > 0, "the meta file counts when there is no record file");
        assert_eq!(list[0].meta.as_deref(), Some("{}"));
        assert!(list_keys(&dir.join("missing")).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_last_record_is_read_from_the_end_of_the_file() {
        let dir = temp_dir("last");
        fs::create_dir_all(&dir).unwrap();
        let data = dir.join("k.ndjson");
        assert_eq!(last_record_time(&data), None, "no file");
        fs::write(&data, "").unwrap();
        assert_eq!(last_record_time(&data), None, "empty file");
        // Longer than the tail: only the end is read, a line cut by the tail start is skipped.
        let lines: Vec<String> = (1..=2000).map(|t| format!("{{\"t\":{t},\"u\":53.1,\"c\":[3.301,3.302]}}")).collect();
        append_records(&data, &lines).unwrap();
        assert!(fs::metadata(&data).unwrap().len() > TAIL_BYTES);
        assert_eq!(last_record_time(&data), Some(2000));
        // A line cut short by a crash at the end does not count.
        let mut file = OpenOptions::new().append(true).open(&data).unwrap();
        file.write_all(b"{\"t\":2001,\"u\":5").unwrap();
        drop(file);
        assert_eq!(last_record_time(&data), Some(2000));
        // A clock that went back: the newest time wins.
        append_records(&data, &[r#"{"t":1500}"#.to_string()]).unwrap();
        assert_eq!(last_record_time(&data), Some(2000));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renames_replace_the_target() {
        let dir = temp_dir("rename");
        fs::create_dir_all(&dir).unwrap();
        let (from, to) = (dir.join("a.tmp"), dir.join("a.json"));
        fs::write(&from, "new").unwrap();
        fs::write(&to, "old").unwrap();
        rename_retry(&from, &to).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "new");
        assert!(rename_retry(&from, &to).is_err(), "a missing source fails at once");
        let not_found = io::Error::from(io::ErrorKind::NotFound);
        assert!(!is_transient_lock(&not_found));
        assert_eq!(is_transient_lock(&io::Error::from_raw_os_error(32)), cfg!(windows));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_from_btoa_decodes() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello", "padding is optional");
        assert_eq!(decode_base64("aGVs\nbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
        assert_eq!(decode_base64("AAEC_w").unwrap(), vec![0, 1, 2, 255], "URL-safe alphabet");
        assert_eq!(decode_base64("iVBORw0KGgo=").unwrap(), b"\x89PNG\r\n\x1a\n");
        assert!(decode_base64("a").is_err(), "a single character cannot encode a byte");
        assert!(decode_base64("aGVs*").is_err());
        assert!(decode_base64("aG=Vs").is_err(), "data after padding");
        assert!(decode_base64("QQ===").is_err());
    }

    #[test]
    fn export_names_are_safe_everywhere() {
        assert_eq!(safe_file_name("ubms JK 2026-11-19 14-05.csv"), "ubms JK 2026-11-19 14-05.csv");
        assert_eq!(safe_file_name(r"a/b\c:d*e?.png"), "c_d_e_.png");
        assert_eq!(safe_file_name("x<y>|\"z\".csv"), "x_y___z_.csv");
        assert_eq!(safe_file_name("a\u{1}b.csv"), "a_b.csv");
        assert_eq!(safe_file_name("  ..hidden.  "), "hidden");
        assert_eq!(safe_file_name(""), "export");
        assert_eq!(safe_file_name("..."), "export");
        assert_eq!(safe_file_name("CON.csv"), "_CON.csv");
        let long = safe_file_name(&format!("{}.csv", "x".repeat(300)));
        assert_eq!(long.chars().count(), MAX_NAME_CHARS);
        assert!(long.ends_with("x.csv"));
        assert_eq!(split_extension("chart.png"), ("chart", ".png"));
        assert_eq!(split_extension("README"), ("README", ""));
        assert_eq!(split_extension(".png"), (".png", ""));
    }

    #[test]
    fn taken_export_names_get_a_number() {
        let dir = temp_dir("save");
        let first = write_unique(&dir, "chart.png", b"1").unwrap();
        let second = write_unique(&dir, "chart.png", b"2").unwrap();
        let third = write_unique(&dir, "chart.png", b"3").unwrap();
        let plain = write_unique(&dir, "README", b"4").unwrap();
        let plain2 = write_unique(&dir, "README", b"5").unwrap();
        assert_eq!(first.file_name().unwrap(), "chart.png");
        assert_eq!(second.file_name().unwrap(), "chart (2).png");
        assert_eq!(third.file_name().unwrap(), "chart (3).png");
        assert_eq!(plain.file_name().unwrap(), "README");
        assert_eq!(plain2.file_name().unwrap(), "README (2)");
        assert_eq!(fs::read(&second).unwrap(), b"2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn temporary_files_sit_next_to_the_file() {
        let temp = temp_path(Path::new("dir").join("k.meta.json").as_path());
        assert_eq!(temp.parent(), Some(Path::new("dir")));
        let name = temp.file_name().unwrap().to_str().unwrap().to_string();
        assert!(name.starts_with("k.meta.json.tmp-"), "{name}");
        assert!(!name.ends_with(".ndjson") && !name.ends_with(".meta.json"), "never listed");
    }
}
