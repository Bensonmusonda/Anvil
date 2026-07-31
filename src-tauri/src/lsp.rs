//! LSP Integration (Phase 5). Spawns rust-analyzer as a child process,
//! handles the Content-Length-framed JSON-RPC protocol over its stdio, and
//! relays requests/notifications between the frontend and the language
//! server.
//!
//! ⚠️ CONFIDENCE NOTE: the Content-Length framing (read_message/write_message
//! below) is a stable, well-documented part of the LSP spec — solid ground.
//! Less certain: the exact `initialize` capabilities object rust-analyzer
//! expects beyond the basics declared here. rust-analyzer logs verbosely to
//! stderr, which is relayed to this process's own stderr below — that's the
//! fastest way to see what it didn't like if completion/hover/diagnostics
//! come back empty rather than erroring outright.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub struct LspState {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
}

impl LspState {
    pub fn new() -> Self {
        LspState {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }
}

pub struct LspPool {
    servers: Mutex<HashMap<String, Arc<LspState>>>,
}

impl LspPool {
    pub fn new() -> Self {
        LspPool {
            servers: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_server(&self, name: &str) -> Option<Arc<LspState>> {
        self.servers.lock().unwrap().get(name).cloned()
    }

    pub fn running_servers(&self) -> Vec<String> {
        self.servers.lock().unwrap().keys().cloned().collect()
    }

    pub async fn start(
        &self,
        name: String,
        command: &str,
        args: &[String],
        workspace_root: String,
        app: AppHandle,
    ) -> Result<(), String> {
        // If a server with this name is running, shut down its stdin / process first
        {
            let mut guard = self.servers.lock().unwrap();
            if let Some(old_state) = guard.remove(&name) {
                if let Some(mut child) = old_state.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }

        let state = Arc::new(LspState::new());
        {
            self.servers.lock().unwrap().insert(name.clone(), Arc::clone(&state));
        }

        start_server_instance(name, command, args, workspace_root, state, app).await
    }

    pub async fn request(
        &self,
        name: &str,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let state = self
            .get_server(name)
            .ok_or_else(|| format!("language server \"{}\" is not running", name))?;
        request(state, method, params).await
    }

    pub fn notify(&self, name: &str, method: &str, params: Value) -> Result<(), String> {
        let state = self
            .get_server(name)
            .ok_or_else(|| format!("language server \"{}\" is not running", name))?;
        notify(&state, method, params)
    }
}

fn write_message(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stdin.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reads one Content-Length-framed JSON-RPC message. Returns Ok(None) on
/// clean EOF (server process exited).
fn read_message<R: BufRead>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break; // blank line ends the header block
        }
        if let Some(value) = line.strip_prefix("Content-Length: ") {
            content_length = value.trim().parse().ok();
        }
    }
    let len = content_length.ok_or("missing Content-Length header")?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
    Ok(Some(value))
}

/// Spawns a language server instance for a given server name.
async fn start_server_instance(
    name: String,
    command: &str,
    args: &[String],
    workspace_root: String,
    state: Arc<LspState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {} — is it installed and on PATH? ({})", command, e))?;

    let stdin = child.stdin.take().ok_or_else(|| format!("failed to capture {} stdin", command))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("failed to capture {} stdout", command))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("failed to capture {} stderr", command))?;

    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);

    let server_label = format!("{}/{}", name, command);
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            eprintln!("[{}] {}", server_label, line);
        }
    });

    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    let server_name = name.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(mut msg)) => {
                    if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                        if let Some(sender) = state_clone.pending.lock().unwrap().remove(&id) {
                            let _ = sender.send(msg);
                            continue;
                        }
                        if msg.get("method").is_some() {
                            let ack = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
                            if let Some(stdin) = state_clone.stdin.lock().unwrap().as_mut() {
                                let _ = write_message(stdin, &ack);
                            }
                        }
                    }

                    // Attach the server name to notifications emitted to frontend
                    if let Value::Object(ref mut map) = msg {
                        map.insert("server".to_string(), json!(server_name));
                    }
                    let _ = app_clone.emit("lsp-notification", msg);
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[{} relay] error reading message: {}", server_name, e);
                    break;
                }
            }
        }
    });

    let root_uri = format!("file://{}", workspace_root);
    let folder_name = Path::new(&workspace_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());

    let init_params = json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "workspaceFolders": [
            { "uri": root_uri, "name": folder_name }
        ],
        "capabilities": {
            "workspace": { "workspaceFolders": true },
            "textDocument": {
                "completion": { "completionItem": { "snippetSupport": false } },
                "hover": { "contentFormat": ["plaintext", "markdown"] },
                "definition": {},
                "publishDiagnostics": {}
            }
        }
    });

    request(Arc::clone(&state), "initialize".to_string(), init_params).await?;
    notify(&state, "initialized", json!({}))?;

    Ok(())
}

pub async fn request(state: Arc<LspState>, method: String, params: Value) -> Result<Value, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);

    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    {
        let mut stdin_guard = state.stdin.lock().unwrap();
        let stdin = stdin_guard.as_mut().ok_or("LSP not started")?;
        write_message(stdin, &msg)?;
    }

    let response = rx.await.map_err(|_| "LSP response channel closed unexpectedly".to_string())?;

    if let Some(error) = response.get("error") {
        return Err(format!("LSP error: {}", error));
    }

    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

pub fn notify(state: &Arc<LspState>, method: &str, params: Value) -> Result<(), String> {
    let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    let mut stdin_guard = state.stdin.lock().unwrap();
    let stdin = stdin_guard.as_mut().ok_or("LSP not started")?;
    write_message(stdin, &msg)
}

