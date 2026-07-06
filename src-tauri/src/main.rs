// Anvil Editor — Phase 5: LSP Integration
//
// LSP-specific state (rust-analyzer's child process, stdin handle, pending
// request map) lives in its own LspState struct (lsp.rs) rather than
// AppState directly, wrapped in an Arc so it can be cloned into the
// background relay threads spawned in lsp::start without fighting the
// borrow checker over AppState's lifetime.

mod agent;
mod config;
mod history;
mod lsp;
mod mcp_host;
mod provider;
mod tool_registry;
mod tools_native;
mod terminal;
mod git;
mod fuzzy;

use config::Config;
use lsp::LspState;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State, Manager};
use terminal::TerminalState;

struct AppState {
    config: Mutex<Option<Config>>,
    workspace_root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    lsp: Arc<LspState>,
    terminal: TerminalState,
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

// --- Phase 3 commands, unchanged ---

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

#[tauri::command]
async fn ai_complete(purpose: String, prompt: String, state: State<'_, AppState>) -> Result<String, String> {
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

// --- Phase 4 command, unchanged ---

#[tauri::command]
async fn agent_run(prompt: String, state: State<'_, AppState>) -> Result<String, String> {
    {
        let mut cfg_guard = state.config.lock().unwrap();
        if cfg_guard.is_none() {
            let path = Config::default_path()?;
            *cfg_guard = Some(Config::load(&path)?);
        }
    }
    let config = state.config.lock().unwrap().clone().unwrap();

    let mut tools = tools_native::definitions();
    let mut mcp_command: Option<(String, Vec<String>)> = None;

    if let Some((_name, server)) = config.mcp_servers.iter().next() {
        match mcp_host::list_tools(&server.command, &server.args).await {
            Ok(mcp_tools) => tools.extend(mcp_tools),
            Err(e) => eprintln!("warning: could not connect to configured MCP server: {}", e),
        }
        mcp_command = Some((server.command.clone(), server.args.clone()));
    }

    let workspace_root = state.workspace_root.lock().unwrap().clone();
    let mcp_ref = mcp_command.as_ref().map(|(c, a)| (c.as_str(), a.as_slice()));

    agent::run(&config, &prompt, &tools, workspace_root.as_deref(), mcp_ref).await
}

// --- Phase 5: LSP commands ---

/// Starts rust-analyzer for the given workspace root. Frontend should only
/// call this for workspaces that actually contain a Cargo.toml.
#[tauri::command]
async fn start_lsp(workspace_root: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    lsp::start(workspace_root, Arc::clone(&state.lsp), app).await
}

/// Generic LSP request passthrough — used for completion, hover, and
/// definition, all of which need a response back.
#[tauri::command]
async fn lsp_request(method: String, params: Value, state: State<'_, AppState>) -> Result<Value, String> {
    lsp::request(Arc::clone(&state.lsp), method, params).await
}

#[tauri::command]
fn lsp_notify(method: String, params: Value, state: State<AppState>) -> Result<(), String> {
    lsp::notify(&state.lsp, &method, params)
}

// --- Phase 6: Terminal commands ---

#[tauri::command]
fn spawn_terminal(cwd: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    terminal::spawn(cwd, &state.terminal, app)
}

#[tauri::command]
fn write_terminal(data: String, state: State<'_, AppState>) -> Result<(), String> {
    terminal::write(&state.terminal, data)
}

#[tauri::command]
fn resize_terminal(rows: u16, cols: u16, state: State<'_, AppState>) -> Result<(), String> {
    terminal::resize(&state.terminal, rows, cols)
}

// --- Window Controls ---

#[tauri::command]
fn win_minimize(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.minimize();
    }
}

#[tauri::command]
fn win_toggle_maximize(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let is_max = win.is_maximized().unwrap_or(false);
        if is_max { let _ = win.unmaximize(); } else { let _ = win.maximize(); }
    }
}

#[tauri::command]
fn win_close(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
}

// --- Phase 6: Git commands ---

fn get_workspace(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let guard = state.workspace_root.lock().unwrap();
    guard.clone().ok_or("No workspace open".to_string())
}

#[tauri::command]
fn git_status(state: State<'_, AppState>) -> Result<Vec<git::GitStatus>, String> {
    let root = get_workspace(&state)?;
    git::status(&root)
}

#[tauri::command]
fn git_diff(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = get_workspace(&state)?;
    git::diff(&root, &path)
}

#[tauri::command]
fn git_stage(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = get_workspace(&state)?;
    git::stage(&root, &path)
}

#[tauri::command]
fn git_unstage(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = get_workspace(&state)?;
    git::unstage(&root, &path)
}

#[tauri::command]
fn git_commit_action(message: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = get_workspace(&state)?;
    git::commit(&root, &message)
}

// --- Phase 6: Fuzzy Finder ---

#[tauri::command]
fn fuzzy_files(query: String, state: State<'_, AppState>) -> Result<Vec<fuzzy::FuzzyResult>, String> {
    let root = get_workspace(&state)?;
    fuzzy::find_files(&root, &query)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(None),
            workspace_root: Mutex::new(None),
            watcher: Mutex::new(None),
            lsp: Arc::new(LspState::new()),
            terminal: TerminalState::new(),
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            start_watching,
            write_text_file,
            revert_file,
            commit_file,
            ai_complete,
            agent_run,
            start_lsp,
            lsp_request,
            lsp_notify,
            spawn_terminal,
            write_terminal,
            resize_terminal,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit_action,
            fuzzy_files,
            win_minimize,
            win_toggle_maximize,
            win_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anvil host");
}
