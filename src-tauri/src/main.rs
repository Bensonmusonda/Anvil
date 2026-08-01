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
mod search;

use config::Config;
use lsp::LspPool;
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
    lsp: Arc<LspPool>,
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

// --- Phase 7: recent workspaces ---

fn recent_workspaces_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())?;
    Ok(PathBuf::from(home).join(".anvil").join("recent_workspaces.json"))
}

fn read_recent_workspaces(path: &Path) -> Vec<String> {
    if !path.exists() {
        return Vec::new();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_recent_workspaces() -> Result<Vec<String>, String> {
    Ok(read_recent_workspaces(&recent_workspaces_path()?))
}

#[tauri::command]
fn add_recent_workspace(path: String) -> Result<(), String> {
    let file_path = recent_workspaces_path()?;
    let mut list = read_recent_workspaces(&file_path);

    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(10);

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create .anvil dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&list)
        .map_err(|e| format!("failed to serialize recent workspaces: {}", e))?;
    fs::write(&file_path, json)
        .map_err(|e| format!("failed to write recent workspaces: {}", e))?;
    Ok(())
}

// --- Phase 7: File/Folder creation ---

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!(
            "invalid name \"{}\": must not contain path separators",
            name
        ));
    }
    Ok(())
}

#[tauri::command]
fn create_file(parent_dir: String, name: String) -> Result<String, String> {
    validate_entry_name(&name)?;
    let path = Path::new(&parent_dir).join(&name);
    if path.exists() {
        return Err(format!("a file or folder named \"{}\" already exists", name));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("failed to create file {}: {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_folder(parent_dir: String, name: String) -> Result<String, String> {
    validate_entry_name(&name)?;
    let path = Path::new(&parent_dir).join(&name);
    if path.exists() {
        return Err(format!("a file or folder named \"{}\" already exists", name));
    }
    fs::create_dir(&path).map_err(|e| format!("failed to create folder {}: {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
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
async fn ai_complete(
    purpose: String,
    prompt: String,
    provider: Option<String>,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    {
        let mut cfg_guard = state.config.lock().unwrap();
        if cfg_guard.is_none() {
            let path = Config::default_path()?;
            *cfg_guard = Some(Config::load(&path)?);
        }
    }
    let config = state.config.lock().unwrap().clone().unwrap();

    let system_prompt = if purpose == "inline" {
        Some(config.custom_prompts.inline.clone())
    } else {
        Some(config.custom_prompts.chat.clone())
    };

    provider::complete(
        &config,
        &purpose,
        &prompt,
        provider.as_deref(),
        model.as_deref(),
        system_prompt.as_deref(),
    )
    .await
}

#[tauri::command]
async fn agent_run(
    prompt: String,
    provider: Option<String>,
    model: Option<String>,
    history: Option<Vec<Value>>,
    request_id: String,          // <-- new
    app: tauri::AppHandle,       // <-- new, Tauri injects this automatically
    state: State<'_, AppState>,
) -> Result<String, String> {
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
    let system_prompt = config.custom_prompts.chat.clone();
    let history = history.unwrap_or_default();

    agent::run(
        &config,
        &prompt,
        &tools,
        workspace_root.as_deref(),
        mcp_ref,
        provider.as_deref(),
        model.as_deref(),
        Some(&system_prompt),
        &history,
        &app,
        &request_id,
    )
    .await
}

// --- Option 4: model switcher + custom prompts ---

#[derive(Debug, serde::Serialize, Clone)]
struct ModelOption {
    provider: String,
    model: String,
    label: String,
}

#[derive(Debug, serde::Serialize)]
struct AvailableModels {
    known_pairs: Vec<ModelOption>,
    providers: Vec<String>,
}

#[tauri::command]
fn get_available_models(state: State<AppState>) -> Result<AvailableModels, String> {
    {
        let mut cfg_guard = state.config.lock().unwrap();
        if cfg_guard.is_none() {
            let path = Config::default_path()?;
            *cfg_guard = Some(Config::load(&path)?);
        }
    }
    let config = state.config.lock().unwrap().clone().unwrap();

    let mut seen = std::collections::HashSet::new();
    let mut known_pairs = Vec::new();
    for route in config.routing.values() {
        let key = (route.provider.clone(), route.model.clone());
        if seen.insert(key) {
            known_pairs.push(ModelOption {
                provider: route.provider.clone(),
                model: route.model.clone(),
                label: format!("{} — {}", route.provider, route.model),
            });
        }
    }
    known_pairs.sort_by(|a, b| a.label.cmp(&b.label));

    let mut providers: Vec<String> = config.providers.keys().cloned().collect();
    providers.sort();

    Ok(AvailableModels { known_pairs, providers })
}

#[tauri::command]
fn get_custom_prompts(state: State<AppState>) -> Result<config::CustomPrompts, String> {
    let mut cfg_guard = state.config.lock().unwrap();
    if cfg_guard.is_none() {
        let path = Config::default_path()?;
        *cfg_guard = Some(Config::load(&path)?);
    }
    Ok(cfg_guard.as_ref().unwrap().custom_prompts.clone())
}

#[tauri::command]
fn save_custom_prompts(inline: String, chat: String, state: State<AppState>) -> Result<(), String> {
    let path = Config::default_path()?;

    // Same raw-JSON-patch approach as save_pane_widths — never reserializes
    // the whole typed Config, so hand-edited fields elsewhere can't be clobbered.
    let raw = fs::read_to_string(&path).map_err(|e| format!("failed to read config: {}", e))?;
    let mut json: Value =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse config JSON: {}", e))?;
    json["custom_prompts"] = serde_json::json!({ "inline": inline, "chat": chat });
    let pretty = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("failed to serialize config: {}", e))?;
    fs::write(&path, pretty).map_err(|e| format!("failed to write config: {}", e))?;

    let mut cfg_guard = state.config.lock().unwrap();
    if let Some(cfg) = cfg_guard.as_mut() {
        cfg.custom_prompts = config::CustomPrompts { inline, chat };
    }
    Ok(())
}

// --- Phase 5: LSP commands ---

/// Starts a language server for the given workspace root. `server_name` is
/// the key in `config.language_servers` (e.g. `"rust"`, `"typescript"`).
/// If omitted, defaults to the first entry whose `project_markers` match
/// files found in the workspace — or falls back to `"rust"` for compatibility.
#[tauri::command]
async fn start_lsp(
    workspace_root: String,
    server_name: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // Load config (lazy, same pattern as ai_complete / agent_run).
    {
        let mut cfg_guard = state.config.lock().unwrap();
        if cfg_guard.is_none() {
            let path = Config::default_path()?;
            *cfg_guard = Some(Config::load(&path).unwrap_or_default());
        }
    }
    let config = state.config.lock().unwrap().clone().unwrap();

    // Resolve which server to start.
    let key = server_name.unwrap_or_else(|| "rust".to_string());
    let server = config
        .language_servers
        .get(&key)
        .ok_or_else(|| format!("no language server configured for \"{}\"", key))?;

    state
        .lsp
        .start(
            key,
            &server.command,
            &server.args,
            workspace_root,
            app,
        )
        .await
}

/// Generic LSP request passthrough — used for completion, hover, and
/// definition, all of which need a response back.
#[tauri::command]
async fn lsp_request(
    server_name: Option<String>,
    method: String,
    params: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let key = server_name.unwrap_or_else(|| "rust".to_string());
    state.lsp.request(&key, method, params).await
}

#[tauri::command]
fn lsp_notify(
    server_name: Option<String>,
    method: String,
    params: Value,
    state: State<AppState>,
) -> Result<(), String> {
    let key = server_name.unwrap_or_else(|| "rust".to_string());
    state.lsp.notify(&key, &method, params)
}

/// Returns the full `language_servers` map from the loaded config so the
/// frontend can build its language registry without duplicating the data.
/// Called by `maybeStartLsp` in lspClient.js at workspace-open time.
#[tauri::command]
fn get_language_servers(state: State<AppState>) -> Result<Value, String> {
    let mut cfg_guard = state.config.lock().unwrap();
    if cfg_guard.is_none() {
        let path = Config::default_path()?;
        *cfg_guard = Some(Config::load(&path).unwrap_or_default());
    }
    let servers = &cfg_guard.as_ref().unwrap().language_servers;
    serde_json::to_value(servers).map_err(|e| format!("failed to serialize language servers: {}", e))
}

#[tauri::command]
fn get_running_servers(state: State<AppState>) -> Vec<String> {
    state.lsp.running_servers()
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

/// Full-text content search across all workspace files. Respects .gitignore.
/// Results are capped at 1,000 matches to keep the frontend responsive.
#[tauri::command]
fn search_in_files(
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    state: State<'_, AppState>,
) -> Result<Vec<search::SearchMatch>, String> {
    let root = get_workspace(&state)?;
    search::search_files(&root, &query, case_sensitive, use_regex)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(None),
            workspace_root: Mutex::new(None),
            watcher: Mutex::new(None),
            lsp: Arc::new(LspPool::new()),
            terminal: TerminalState::new(),
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            create_file,
            create_folder,
            delete_path,
            rename_path,
            get_recent_workspaces,
            add_recent_workspace,
            start_watching,
            write_text_file,
            revert_file,
            commit_file,
            ai_complete,
            get_available_models,
            get_custom_prompts,
            save_custom_prompts,
            agent_run,
            start_lsp,
            lsp_request,
            lsp_notify,
            get_language_servers,
            get_running_servers,
            spawn_terminal,
            write_terminal,
            resize_terminal,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit_action,
            fuzzy_files,
            search_in_files,
            win_minimize,
            win_toggle_maximize,
            win_close,
            save_pane_widths,
            get_pane_widths
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anvil host");
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("{} does not exist", path));
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("failed to delete directory {}: {}", path, e))
    } else {
        fs::remove_file(p).map_err(|e| format!("failed to delete file {}: {}", path, e))
    }
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String, state: State<AppState>) -> Result<String, String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("{} does not exist", old_path));
    }

    // Validate just the final path component (the actual new file/folder
    // name) — file_name() extracts it correctly whether new_path stayed
    // in the same directory or pointed somewhere else entirely.
    let name = new
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{} has no valid file/folder name", new_path))?;
    validate_entry_name(name)?;

    let new_parent = new
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", new_path))?;
    if !new_parent.is_dir() {
        return Err(format!(
            "destination directory {} does not exist",
            new_parent.display()
        ));
    }

    if new.exists() {
        return Err(format!(
            "a file or folder named \"{}\" already exists at the destination",
            name
        ));
    }

    // Relocate the snapshot before the actual rename/move, so a failure
    // here leaves the file untouched rather than moved-but-orphaned. Only
    // possible (and only needed) if a workspace is open; operating outside
    // one just skips history bookkeeping rather than erroring.
    if let Some(root) = state.workspace_root.lock().unwrap().as_ref() {
        history::relocate_snapshot(root, old, new)?;
    }

    fs::rename(old, new)
        .map_err(|e| format!("failed to rename {} to {}: {}", old_path, new_path, e))?;

    Ok(new.to_string_lossy().to_string())
}

#[tauri::command]
fn get_pane_widths(state: State<AppState>) -> Result<config::PaneWidths, String> {
    let mut cfg_guard = state.config.lock().unwrap();
    if cfg_guard.is_none() {
        let path = Config::default_path()?;
        *cfg_guard = Some(Config::load(&path)?);
    }
    Ok(cfg_guard.as_ref().unwrap().pane_widths.clone())
}

#[tauri::command]
fn save_pane_widths(left: u32, right: u32, state: State<AppState>) -> Result<(), String> {
    let path = Config::default_path()?;

    // Patches just the pane_widths key in the raw JSON on disk, rather than
    // reserializing the whole typed Config — Config only derives
    // Deserialize, deliberately, so a resize save can never clobber a
    // hand-edited field (providers, routing, mcp_servers, or anything the
    // typed struct doesn't model) elsewhere in the file.
    let raw = fs::read_to_string(&path).map_err(|e| format!("failed to read config: {}", e))?;
    let mut json: Value =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse config JSON: {}", e))?;
    json["pane_widths"] = serde_json::json!({ "left": left, "right": right });
    let pretty = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("failed to serialize config: {}", e))?;
    fs::write(&path, pretty).map_err(|e| format!("failed to write config: {}", e))?;

    // Keep the cached in-memory config in sync too, so nothing reading
    // state.config this session sees stale widths before a restart.
    let mut cfg_guard = state.config.lock().unwrap();
    if let Some(cfg) = cfg_guard.as_mut() {
        cfg.pane_widths = config::PaneWidths { left, right };
    }
    Ok(())
}
