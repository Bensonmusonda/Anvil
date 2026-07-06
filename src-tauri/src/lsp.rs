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

/// Spawns rust-analyzer for the given workspace root, starts background
/// threads relaying stderr (for diagnosis) and stdout (responses resolve
/// pending requests by id; notifications like publishDiagnostics are
/// emitted to the frontend), then performs the initialize handshake.
pub async fn start(workspace_root: String, state: Arc<LspState>, app: AppHandle) -> Result<(), String> {
    let mut child = Command::new("rust-analyzer")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn rust-analyzer — is it installed and on PATH? ({})", e))?;

    let stdin = child.stdin.take().ok_or("failed to capture rust-analyzer stdin")?;
    let stdout = child.stdout.take().ok_or("failed to capture rust-analyzer stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture rust-analyzer stderr")?;

    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            eprintln!("[rust-analyzer] {}", line);
        }
    });

    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(msg)) => {
                    if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                        if let Some(sender) = state_clone.pending.lock().unwrap().remove(&id) {
                            let _ = sender.send(msg);
                            continue;
                        }
                        // Has an id but doesn't match anything we sent —
                        // a server-to-client REQUEST (e.g.
                        // workspace/diagnostic/refresh), not a response.
                        // LSP requires acknowledging these or a strict
                        // server may stall waiting for a reply.
                        if msg.get("method").is_some() {
                            let ack = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
                            if let Some(stdin) = state_clone.stdin.lock().unwrap().as_mut() {
                                let _ = write_message(stdin, &ack);
                            }
                        }
                    }
                    let _ = app_clone.emit("lsp-notification", msg);
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[rust-analyzer relay] error reading message: {}", e);
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
        let stdin = stdin_guard.as_mut().ok_or("LSP not started — open a Rust workspace first")?;
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
    let stdin = stdin_guard.as_mut().ok_or("LSP not started — open a Rust workspace first")?;
    write_message(stdin, &msg)
}
