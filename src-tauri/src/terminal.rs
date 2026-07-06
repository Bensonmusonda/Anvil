//! Integrated terminal — spawns a PTY with the user's shell, relays I/O
//! between the frontend (xterm.js) and the child process.
//!
//! Design: TerminalState holds the pty writer and child behind Mutexes so
//! Tauri commands can access them. A background std::thread (not tokio —
//! portable-pty's reader is blocking) reads pty output and emits
//! `terminal-data` events to the frontend.

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Wraps the pty writer, master handle, and child process. Lives in AppState.
pub struct TerminalState {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn portable_pty::Child + Send>>>,
    alive: Mutex<bool>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            master: Mutex::new(None),
            child: Mutex::new(None),
            alive: Mutex::new(false),
        }
    }
}

/// Resolve which shell to spawn: $SHELL → /bin/bash → /bin/sh
fn resolve_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }
    if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

/// Spawn a pty with the user's shell in the given working directory.
/// Starts a background thread that reads pty output and emits
/// `terminal-data` events (payload: raw bytes as a String).
pub fn spawn(
    cwd: String,
    state: &TerminalState,
    app: AppHandle,
) -> Result<(), String> {
    // Don't double-spawn
    {
        let alive = state.alive.lock().unwrap();
        if *alive {
            return Err("terminal already running".into());
        }
    }

    let pty_system = NativePtySystem::default();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {}", e))?;

    let shell = resolve_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // Login shell flag for proper rc sourcing
    cmd.arg("--login");
    cmd.cwd(&cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {}: {}", shell, e))?;

    // Drop the slave in the parent — child holds its own reference
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {}", e))?;

    *state.writer.lock().unwrap() = Some(writer);
    *state.child.lock().unwrap() = Some(child);
    *state.master.lock().unwrap() = Some(pair.master);
    *state.alive.lock().unwrap() = true;

    // Background thread: read pty output → emit events
    // Using std::thread, not tokio, because portable-pty's reader is blocking.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited
                Ok(n) => {
                    // Emit raw bytes as a string. xterm.js handles escape codes.
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("terminal-data", data);
                }
                Err(_) => break,
            }
        }
        // Terminal closed — notify frontend
        let _ = app.emit("terminal-exit", ());
    });

    Ok(())
}

/// Send raw input (keystrokes) from the frontend to the pty.
pub fn write(state: &TerminalState, data: String) -> Result<(), String> {
    let mut guard = state.writer.lock().unwrap();
    let writer = guard
        .as_mut()
        .ok_or("terminal not running")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("failed to write to pty: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("failed to flush pty: {}", e))?;
    Ok(())
}

/// Notify the pty of a terminal resize.
pub fn resize(state: &TerminalState, rows: u16, cols: u16) -> Result<(), String> {
    let guard = state.master.lock().unwrap();
    let master = guard
        .as_ref()
        .ok_or("terminal not running")?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to resize pty: {}", e))?;
    Ok(())
}
