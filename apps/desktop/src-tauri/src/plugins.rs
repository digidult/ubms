//! Plugins: JavaScript files that add device drivers to the desktop app.
//!
//! One `.js` file in a `plugins` folder next to the app is one plugin (`docs/plugins.md`). This
//! module only finds and reads the files; the web app (`apps/web/src/plugins.js`) evaluates them,
//! checks their driver definitions and registers them. Like the rest of the crate it knows
//! nothing about batteries.
//!
//! - Folders, resolved once per run from the path of the executable (`plugin_dirs`, pure and
//!   unit tested like the portable rule in `history.rs`): Windows and Linux `<folder of the
//!   executable>/plugins`; a Linux AppImage (`APPIMAGE` set) `<folder of the AppImage
//!   file>/plugins`, because the executable runs from a temporary mount; macOS
//!   `<name>.app/Contents/MacOS/plugins` and `<folder that contains the .app>/plugins` (the
//!   second one is where users can put files without opening the bundle).
//! - Every `*.js` file (the extension in any case) that is a regular file, or a link to one, in
//!   those folders, not in subfolders. Files are sorted by name, case-insensitively. A file larger
//!   than 1 MiB or not valid UTF-8 is skipped with an error entry, and so is a file whose name was
//!   already read from an earlier folder. A missing folder is not an error.
//! - Read only, on the blocking thread pool. Errors are strings, like everywhere in the bridge.

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

use crate::err;

/// Name of the plugin folder.
const PLUGIN_DIR: &str = "plugins";
/// Largest plugin file that is read (1 MiB).
const MAX_PLUGIN_BYTES: u64 = 1024 * 1024;
/// Error texts the web app also knows (apps/web/src/plugins.js marks them for translation).
const TOO_LARGE: &str = "The file is larger than 1 MiB";
const NOT_UTF8: &str = "The file is not valid UTF-8 text";
const SAME_NAME: &str = "A plugin with this file name was already read from an earlier folder";

/// Result of `plugins_list`.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    /// Every folder that is looked at, also missing ones, so the app can tell where plugins go.
    dirs: Vec<String>,
    plugins: Vec<Plugin>,
    errors: Vec<PluginError>,
}

/// One plugin file: its name and its text.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Plugin {
    file: String,
    source: String,
}

/// A file that was not read, or a folder that could not be listed (then `file` is its path).
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct PluginError {
    file: String,
    error: String,
}

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

// ----- Folders -----------------------------------------------------------------------------------

fn is_separator(c: char, os: Os) -> bool {
    c == '/' || (os == Os::Windows && c == '\\')
}

/// The folder part of `path` (a path in the syntax of `os`), or None for a bare name.
fn parent(path: &str, os: Os) -> Option<&str> {
    let index = path.rfind(|c: char| is_separator(c, os))?;
    // "/ubms" lives in the root folder; keep its separator.
    Some(if index == 0 { &path[..1] } else { &path[..index] })
}

/// `dir` plus `name`, with the separator `dir` already uses (Windows accepts both).
fn join(dir: &str, name: &str, os: Os) -> String {
    if dir.ends_with(|c: char| is_separator(c, os)) {
        return format!("{dir}{name}");
    }
    let separator = if os == Os::Windows && (dir.contains('\\') || !dir.contains('/')) { '\\' } else { '/' };
    format!("{dir}{separator}{name}")
}

/// The folder that contains the app bundle when `dir` is `<name>.app/Contents/MacOS`.
fn bundle_parent(dir: &str) -> Option<&str> {
    let bundle_path = dir.strip_suffix("/Contents/MacOS")?;
    let (outer, bundle) = bundle_path.rsplit_once('/')?;
    if bundle.len() > ".app".len() && bundle.to_ascii_lowercase().ends_with(".app") {
        Some(if outer.is_empty() { "/" } else { outer })
    } else {
        None
    }
}

/// The plugin folders of an executable at `exe` (a path in the syntax of `os`), in reading order.
/// `appimage` is the value of `APPIMAGE`, which only counts on Linux.
fn plugin_dirs(os: Os, exe: &str, appimage: Option<&str>) -> Vec<String> {
    let base = match appimage {
        Some(image) if os == Os::Linux && !image.is_empty() => image,
        _ => exe,
    };
    let Some(dir) = parent(base, os) else {
        return Vec::new();
    };
    let mut dirs = vec![join(dir, PLUGIN_DIR, os)];
    if os == Os::MacOs {
        if let Some(outer) = bundle_parent(dir) {
            dirs.push(join(outer, PLUGIN_DIR, os));
        }
    }
    dirs
}

/// The plugin folders of this run, resolved on first use. A path that is not valid Unicode is
/// converted lossily (the folder of such an executable is not found).
fn current_dirs() -> Result<Vec<PathBuf>, String> {
    static DIRS: OnceLock<Result<Vec<PathBuf>, String>> = OnceLock::new();
    DIRS.get_or_init(|| {
        let exe = std::env::current_exe().map_err(err)?;
        let appimage = std::env::var_os("APPIMAGE").map(|value| value.to_string_lossy().into_owned());
        let dirs = plugin_dirs(Os::current(), &exe.to_string_lossy(), appimage.as_deref());
        Ok(dirs.into_iter().map(PathBuf::from).collect())
    })
    .clone()
}

// ----- Files -------------------------------------------------------------------------------------

/// True for names with the extension `.js` in any case (`a.js`, `B.JS`; not `.js` or `a.json`).
fn is_plugin_name(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("js"))
}

/// File name order: case-insensitive, then by bytes so the order is always the same.
fn compare_names(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// The text of one plugin file; None when the path is not a regular file (a folder named
/// `x.js`, a device or pipe, which would block a read).
fn read_plugin(path: &Path) -> Result<Option<String>, String> {
    let meta = fs::metadata(path).map_err(err)?;
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_PLUGIN_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    // The file may grow between the size check and the read.
    File::open(path).map_err(err)?.take(MAX_PLUGIN_BYTES + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > MAX_PLUGIN_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    let text = String::from_utf8(bytes).map_err(|_| NOT_UTF8.to_string())?;
    // A byte order mark from an editor is not part of the module.
    Ok(Some(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    }))
}

/// Reads the plugin files of one folder into `listing`; `seen` holds the names read so far.
fn read_dir_into(dir: &Path, listing: &mut Listing, seen: &mut BTreeSet<String>) {
    let folder_error = |e: io::Error| PluginError {
        file: dir.display().to_string(),
        error: format!("Could not read the plugin folder: {e}"),
    };
    // Checked first: listing a file fails with a different error on every system.
    match fs::metadata(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Ok(meta) if !meta.is_dir() => {
            listing.errors.push(folder_error(io::Error::other("it is a file, not a folder")));
            return;
        }
        _ => {}
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Err(e) => {
            listing.errors.push(folder_error(e));
            return;
        }
    };
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_plugin_name(&name) {
                    files.push((name, entry.path()));
                }
            }
            Err(e) => listing.errors.push(folder_error(e)),
        }
    }
    files.sort_by(|a, b| compare_names(&a.0, &b.0));
    for (name, path) in files {
        if seen.contains(&name) {
            listing.errors.push(PluginError { file: name, error: SAME_NAME.to_string() });
            continue;
        }
        match read_plugin(&path) {
            Ok(Some(source)) => {
                seen.insert(name.clone());
                listing.plugins.push(Plugin { file: name, source });
            }
            Ok(None) => {}
            Err(error) => {
                seen.insert(name.clone());
                listing.errors.push(PluginError { file: name, error });
            }
        }
    }
}

/// Reads the plugins of every folder, earlier folders first; the plugins end up sorted by name.
fn read_plugins(dirs: &[PathBuf]) -> Listing {
    let mut listing = Listing { dirs: dirs.iter().map(|dir| dir.display().to_string()).collect(), ..Listing::default() };
    let mut seen = BTreeSet::new();
    for dir in dirs {
        read_dir_into(dir, &mut listing, &mut seen);
    }
    listing.plugins.sort_by(|a, b| compare_names(&a.file, &b.file));
    listing
}

// ----- Command -----------------------------------------------------------------------------------

/// Lists the plugin folders and reads every plugin file in them.
#[tauri::command]
pub async fn plugins_list() -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(|| current_dirs().map(|dirs| read_plugins(&dirs)))
        .await
        .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder in the system temp folder, unique per test and process.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ubms-plugins-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(listing: &Listing) -> Vec<&str> {
        listing.plugins.iter().map(|p| p.file.as_str()).collect()
    }

    fn error_names(listing: &Listing) -> Vec<&str> {
        listing.errors.iter().map(|e| e.file.as_str()).collect()
    }

    #[test]
    fn windows_and_linux_use_the_folder_of_the_executable() {
        assert_eq!(plugin_dirs(Os::Windows, r"C:\Program Files\ubms\ubms.exe", None), vec![r"C:\Program Files\ubms\plugins"]);
        assert_eq!(plugin_dirs(Os::Windows, "D:/Tools/ubms/ubms.exe", None), vec!["D:/Tools/ubms/plugins"]);
        assert_eq!(plugin_dirs(Os::Windows, r"C:\ubms.exe", None), vec![r"C:\plugins"]);
        assert_eq!(plugin_dirs(Os::Linux, "/opt/ubms/ubms", None), vec!["/opt/ubms/plugins"]);
        assert_eq!(plugin_dirs(Os::Linux, "/home/ann/ubms/ubms-desktop", None), vec!["/home/ann/ubms/plugins"]);
        assert_eq!(plugin_dirs(Os::Linux, "/ubms", None), vec!["/plugins"]);
    }

    #[test]
    fn an_appimage_uses_the_folder_of_the_appimage_file() {
        let exe = "/tmp/.mount_ubmsAb12/usr/bin/ubms-desktop";
        assert_eq!(plugin_dirs(Os::Linux, exe, Some("/home/ann/Apps/ubms_0.1.0_amd64.AppImage")), vec!["/home/ann/Apps/plugins"]);
        assert_eq!(plugin_dirs(Os::Linux, exe, Some("")), vec!["/tmp/.mount_ubmsAb12/usr/bin/plugins"], "empty APPIMAGE");
        assert_eq!(plugin_dirs(Os::Windows, r"C:\Apps\ubms.exe", Some("/x/ubms.AppImage")), vec![r"C:\Apps\plugins"], "Linux only");
        assert_eq!(plugin_dirs(Os::MacOs, "/Users/ann/bin/ubms", Some("/x/ubms.AppImage")), vec!["/Users/ann/bin/plugins"], "Linux only");
    }

    #[test]
    fn macos_reads_the_bundle_and_the_folder_of_the_bundle() {
        assert_eq!(
            plugin_dirs(Os::MacOs, "/Applications/ubms.app/Contents/MacOS/ubms", None),
            vec!["/Applications/ubms.app/Contents/MacOS/plugins", "/Applications/plugins"]
        );
        assert_eq!(
            plugin_dirs(Os::MacOs, "/Users/ann/Downloads/UBMS.APP/Contents/MacOS/ubms", None),
            vec!["/Users/ann/Downloads/UBMS.APP/Contents/MacOS/plugins", "/Users/ann/Downloads/plugins"]
        );
        assert_eq!(plugin_dirs(Os::MacOs, "/ubms.app/Contents/MacOS/ubms", None), vec!["/ubms.app/Contents/MacOS/plugins", "/plugins"]);
        assert_eq!(
            plugin_dirs(Os::MacOs, "/Users/ann/ubms/target/debug/ubms-desktop", None),
            vec!["/Users/ann/ubms/target/debug/plugins"],
            "a development build is no bundle"
        );
        assert_eq!(plugin_dirs(Os::MacOs, "/x/.app/Contents/MacOS/ubms", None).len(), 1, "a bundle needs a name");
        assert_eq!(plugin_dirs(Os::Linux, "/x/ubms.app/Contents/MacOS/ubms", None).len(), 1, "macOS only");
    }

    #[test]
    fn a_bare_name_has_no_folder() {
        assert!(plugin_dirs(Os::Linux, "ubms", None).is_empty());
        assert!(plugin_dirs(Os::Windows, "ubms.exe", None).is_empty());
        assert!(plugin_dirs(Os::Linux, r"C:\Apps\ubms.exe", None).is_empty(), "a backslash is no separator on Linux");
    }

    #[test]
    fn plugin_names_need_the_js_extension() {
        for name in ["a.js", "B.JS", "x.Js", "a.min.js", "with space.js"] {
            assert!(is_plugin_name(name), "{name}");
        }
        for name in [".js", "a.json", "a.mjs", "a.js.txt", "js", "readme"] {
            assert!(!is_plugin_name(name), "{name}");
        }
    }

    #[test]
    fn names_sort_case_insensitively() {
        let mut list = vec!["b.js", "B.js", "a.JS", "10-x.js", "C.js"];
        list.sort_by(|a, b| compare_names(a, b));
        assert_eq!(list, vec!["10-x.js", "a.JS", "B.js", "b.js", "C.js"]);
    }

    #[test]
    fn a_missing_folder_gives_empty_lists() {
        let dir = temp_dir("missing").join("plugins");
        let listing = read_plugins(&[dir.clone()]);
        assert_eq!(listing.dirs, vec![dir.display().to_string()]);
        assert!(listing.plugins.is_empty());
        assert!(listing.errors.is_empty());
        assert_eq!(read_plugins(&[]), Listing::default());
    }

    #[test]
    fn reads_plugin_files_sorted_and_reports_bad_ones() {
        let dir = temp_dir("read");
        fs::write(dir.join("b.js"), "export default () => [];").unwrap();
        fs::write(dir.join("a.JS"), "// a").unwrap();
        fs::write(dir.join("bom.js"), "\u{feff}// bom").unwrap();
        fs::write(dir.join("notes.txt"), "not a plugin").unwrap();
        fs::write(dir.join("data.json"), "{}").unwrap();
        fs::write(dir.join("bad.js"), b"//\xff\xfe").unwrap();
        let limit = usize::try_from(MAX_PLUGIN_BYTES).unwrap();
        fs::write(dir.join("exact.js"), vec![b' '; limit]).unwrap();
        fs::write(dir.join("big.js"), vec![b' '; limit + 1]).unwrap();
        fs::create_dir_all(dir.join("folder.js")).unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("inner.js"), "// not recursive").unwrap();

        let listing = read_plugins(&[dir.clone()]);
        assert_eq!(names(&listing), vec!["a.JS", "b.js", "bom.js", "exact.js"]);
        assert_eq!(listing.plugins[0].source, "// a");
        assert_eq!(listing.plugins[1].source, "export default () => [];");
        assert_eq!(listing.plugins[2].source, "// bom", "the byte order mark is removed");
        assert_eq!(listing.plugins[3].source.len(), limit, "exactly 1 MiB is fine");
        assert_eq!(
            listing.errors,
            vec![
                PluginError { file: "bad.js".to_string(), error: NOT_UTF8.to_string() },
                PluginError { file: "big.js".to_string(), error: TOO_LARGE.to_string() },
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_earlier_folder_wins_for_the_same_name() {
        let root = temp_dir("two");
        let inner = root.join("ubms.app").join("Contents").join("MacOS").join("plugins");
        let outer = root.join("plugins");
        fs::create_dir_all(&inner).unwrap();
        fs::create_dir_all(&outer).unwrap();
        fs::write(inner.join("same.js"), "// inner").unwrap();
        fs::write(inner.join("z.js"), "// z").unwrap();
        fs::write(outer.join("same.js"), "// outer").unwrap();
        fs::write(outer.join("a.js"), "// a").unwrap();
        fs::write(inner.join("huge.js"), vec![b' '; usize::try_from(MAX_PLUGIN_BYTES).unwrap() + 1]).unwrap();
        fs::write(outer.join("huge.js"), "// a failed name is not read again").unwrap();

        let listing = read_plugins(&[inner.clone(), outer.clone()]);
        assert_eq!(listing.dirs.len(), 2);
        assert_eq!(names(&listing), vec!["a.js", "same.js", "z.js"], "sorted over both folders");
        assert_eq!(listing.plugins[1].source, "// inner");
        assert_eq!(error_names(&listing), vec!["huge.js", "huge.js", "same.js"]);
        assert_eq!(listing.errors[0].error, TOO_LARGE);
        assert_eq!(listing.errors[1].error, SAME_NAME);
        assert_eq!(listing.errors[2].error, SAME_NAME);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_instead_of_the_folder_is_reported() {
        let root = temp_dir("file");
        let not_a_folder = root.join("plugins");
        fs::write(&not_a_folder, "oops").unwrap();
        let listing = read_plugins(&[not_a_folder.clone()]);
        assert!(listing.plugins.is_empty());
        assert_eq!(error_names(&listing), vec![not_a_folder.display().to_string()]);
        assert!(listing.errors[0].error.starts_with("Could not read the plugin folder: "), "{}", listing.errors[0].error);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_listing_serializes_as_the_web_app_expects() {
        let listing = Listing {
            dirs: vec!["/a/plugins".to_string()],
            plugins: vec![Plugin { file: "x.js".to_string(), source: "// x".to_string() }],
            errors: vec![PluginError { file: "y.js".to_string(), error: NOT_UTF8.to_string() }],
        };
        assert_eq!(
            serde_json::to_string(&listing).unwrap(),
            r#"{"dirs":["/a/plugins"],"plugins":[{"file":"x.js","source":"// x"}],"errors":[{"file":"y.js","error":"The file is not valid UTF-8 text"}]}"#
        );
    }
}
