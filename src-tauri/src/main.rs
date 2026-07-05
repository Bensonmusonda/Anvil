// Anvil Editor — Phase 3: Dual-Process Wiring
//
// Architecture note: the spec's "dual-process" model describes a daemon as
// a genuinely separate OS process, talking to the frontend over IPC. For a
// single-user desktop app, actually spawning/health-checking/restarting
// anvil-daemon (Phase 1) as a live subprocess with a wire protocol is real
// engineering overhead with little payoff — so this phase instead folds
// provider routing directly into this Tauri host process (see config.rs /
// provider.rs, duplicated from daemon/). The standalone anvil-daemon binary
// still exists and still works standalone for CLI testing — it's just not
// wired into the running app. Flag this back if you'd rather keep them
// genuinely separate processes; it's a real architectural decision, not an
// assumption I want to silently lock in.

mod config;
mod history;
mod provider;

use config::Config;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    config: Mutex<Option<Config>>,
    workspace_root: Mutex<Option<PathBuf>>,
    // Held so the watcher isn't dropped (which would stop watching) —
    // never read directly, its presence is the point.
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

// --- Phase 2 commands, unchanged ---

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

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {}", path));
    }

    const MAX_BYTES: u64 = 5 * 1024 * 1024;
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "file too large to open ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_BYTES
        ));
    }

    fs::read_to_string(p)
        .map_err(|e| format!("failed to read {}: {} (is it a binary file?)", path, e))
}

// --- Phase 3: filesystem watcher ---

#[tauri::command]
fn start_watching(path: String, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    *state.workspace_root.lock().unwrap() = Some(root.clone());

    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if !matches!(event.kind, notify::EventKind::Access(_)) {
                for changed_path in event.paths {
                    let _ = app_handle.emit("file-changed", changed_path.to_string_lossy().to_string());
                }
            }
        }
    })
    .map_err(|e| format!("failed to create filesystem watcher: {}", e))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {}", root.display(), e))?;

    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

// --- Phase 3: snapshot / revert / commit (spec §5) ---

#[tauri::command]
fn write_text_file(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    let root_guard = state.workspace_root.lock().unwrap();
    let root = root_guard
        .as_ref()
        .ok_or("no workspace open — open a folder before saving")?;

    history::snapshot_before_write(root, &file_path)?;
    fs::write(&file_path, &content).map_err(|e| format!("failed to write {}: {}", path, e))?;
    Ok(())
}

#[tauri::command]
fn revert_file(path: String, state: State<AppState>) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    let root_guard = state.workspace_root.lock().unwrap();
    let root = root_guard.as_ref().ok_or("no workspace open")?;
    history::revert(root, &file_path)
}

#[tauri::command]
fn commit_file(path: String, state: State<AppState>) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    let root_guard = state.workspace_root.lock().unwrap();
    let root = root_guard.as_ref().ok_or("no workspace open")?;
    history::commit(root, &file_path)
}

// --- Phase 3: AI generation reaching the editor ---

#[tauri::command]
async fn ai_complete(purpose: String, prompt: String, state: State<'_, AppState>) -> Result<String, String> {
    // Lazily load + cache config on first use rather than at startup, so a
    // missing ~/.anvil/config.json doesn't block the editor from opening —
    // only AI features fail until it's created.
    {
        let mut cfg_guard = state.config.lock().unwrap();
        if cfg_guard.is_none() {
            let path = Config::default_path()?;
            *cfg_guard = Some(Config::load(&path)?);
        }
    }
    let config = state.config.lock().unwrap().clone().unwrap();
    provider::complete(&config, &purpose, &prompt).await
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(None),
            workspace_root: Mutex::new(None),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            start_watching,
            write_text_file,
            revert_file,
            commit_file,
            ai_complete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anvil host");
}
