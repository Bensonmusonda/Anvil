// Anvil Editor — Phase 2: Text Surface Assembly
//
// Filesystem access lives here (the Tauri host process) for now, not in the
// standalone anvil-daemon from Phase 1. The spec's dual-process model routes
// this through the separate daemon over IPC — that's Phase 3's job
// ("Dual-Process Wiring"). This phase proves the editor + file browsing UI
// works first, as a deliberate stepping stone.

use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

/// Lists the immediate contents of `path`, directories first, both groups
/// alphabetical. Dotfiles/dotdirs are skipped to keep the tree readable.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    let mut entries: Vec<DirEntryInfo> = fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {}", path, e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            Some(DirEntryInfo {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir: file_type.is_dir(),
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Reads a text file's full contents. Capped defensively — Phase 2 is about
/// browsing/opening real files, not handling arbitrarily huge ones yet.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {}", path));
    }

    const MAX_BYTES: u64 = 5 * 1024 * 1024; // 5MB
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "file too large to open in Phase 2 ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_BYTES
        ));
    }

    fs::read_to_string(p)
        .map_err(|e| format!("failed to read {}: {} (is it a binary file?)", path, e))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_dir, read_text_file])
        .run(tauri::generate_context!())
        .expect("error while running Anvil host");
}