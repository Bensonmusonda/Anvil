//! Chat session persistence (Phase 9).
//!
//! Follows the same "patch narrowly, never blind-overwrite" spirit as
//! config.rs's save_pane_widths / save_custom_prompts, just at file
//! granularity instead of JSON-key granularity: each session owns its own
//! file, so saving one chat never touches another chat's data. `index.json`
//! is small (just id/title/updated_at per session) so a full rewrite of
//! *it* on every save is cheap and safe — it's not the thing we're trying
//! to avoid reserializing.
//!
//! Layout:
//!   ~/.anvil/chats/index.json        [{ id, title, updated_at }, ...]
//!   ~/.anvil/chats/<session-id>.json { id, title, created_at, updated_at, messages }
//!
//! This module is a plain library module (no #[tauri::command]s), same
//! convention as git.rs/history.rs/fuzzy.rs — main.rs owns the actual
//! command wrappers, since generate_chat_title needs AppState/Config access
//! and it reads oddly to split that command's plumbing across two files.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
    /// Reasoning/thinking text for this turn, if any. Only ever populated
    /// for role "assistant". Persisted so a reloaded session can rebuild
    /// its collapsed thinking blocks — but never fed back into the
    /// `history` array sent to agent_run/the provider (see agentPanel.js's
    /// historyForThisTurn — reasoning is stripped before that array is
    /// built), since DeepSeek's API 400s if reasoning_content is replayed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatIndexEntry {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

fn chats_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())?;
    Ok(PathBuf::from(home).join(".anvil").join("chats"))
}

fn index_path() -> Result<PathBuf, String> {
    Ok(chats_dir()?.join("index.json"))
}

/// `id` always originates as a `crypto.randomUUID()` from the frontend, but
/// it still crosses into a filesystem path, so it gets the same treatment
/// as `validate_entry_name` in main.rs before that happens.
fn session_path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid chat session id \"{}\"", id));
    }
    Ok(chats_dir()?.join(format!("{}.json", id)))
}

/// Seconds-since-epoch as a string. No chrono dependency exists elsewhere in
/// this crate (checked config.rs/main.rs) so this avoids adding one just for
/// a timestamp that's only ever used for sort order, never formatted for
/// display.
fn now_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn read_index(path: &Path) -> Vec<ChatIndexEntry> {
    if !path.exists() {
        return Vec::new();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_index(path: &Path, entries: &[ChatIndexEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create chats dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("failed to serialize chat index: {}", e))?;
    fs::write(path, json).map_err(|e| format!("failed to write chat index: {}", e))
}

/// Inserts or updates `entry` in the index (matched by id), most-recently-
/// updated first, then rewrites the (small) index file. This is the only
/// part of a save/rename/delete that ever touches index.json — the rest of
/// each operation is scoped to that one session's own file.
fn upsert_index_entry(entry: ChatIndexEntry) -> Result<(), String> {
    let path = index_path()?;
    let mut entries = read_index(&path);
    entries.retain(|e| e.id != entry.id);
    entries.insert(0, entry);
    write_index(&path, &entries)
}

pub fn list_sessions() -> Result<Vec<ChatIndexEntry>, String> {
    Ok(read_index(&index_path()?))
}

pub fn load_session(id: &str) -> Result<ChatSession, String> {
    let path = session_path(id)?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read chat session {}: {}", id, e))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse chat session {}: {}", id, e))
}

/// Upsert: writes the full session file (only this session's file — every
/// other session and the rest of the index are untouched) and refreshes its
/// index entry. Called after every successful turn, not just on "New Chat",
/// so a force-quit never loses the most recent exchange; also correctly
/// handles edit/resend, which truncates and replaces the tail of
/// `conversationHistory` before this is called again.
pub fn save_session(id: &str, title: &str, messages: Vec<ChatMessage>) -> Result<(), String> {
    let path = session_path(id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create chats dir: {}", e))?;
    }

    // Preserve created_at across resaves. The file already exists after the
    // first save, so this is a cheap re-read rather than threading
    // created_at through every caller.
    let created_at = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ChatSession>(&raw).ok())
        .map(|s| s.created_at)
        .unwrap_or_else(now_stamp);
    let updated_at = now_stamp();

    let session = ChatSession {
        id: id.to_string(),
        title: title.to_string(),
        created_at,
        updated_at: updated_at.clone(),
        messages,
    };
    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("failed to serialize chat session: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("failed to write chat session {}: {}", id, e))?;

    upsert_index_entry(ChatIndexEntry {
        id: id.to_string(),
        title: title.to_string(),
        updated_at,
    })
}

pub fn delete_session(id: &str) -> Result<(), String> {
    let path = session_path(id)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("failed to delete chat session {}: {}", id, e))?;
    }
    let index_file = index_path()?;
    let mut entries = read_index(&index_file);
    entries.retain(|e| e.id != id);
    write_index(&index_file, &entries)
}

pub fn rename_session(id: &str, title: &str) -> Result<(), String> {
    let path = session_path(id)?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read chat session {}: {}", id, e))?;
    let mut session: ChatSession = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse chat session {}: {}", id, e))?;
    session.title = title.to_string();
    session.updated_at = now_stamp();
    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("failed to serialize chat session: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("failed to write chat session {}: {}", id, e))?;

    upsert_index_entry(ChatIndexEntry {
        id: id.to_string(),
        title: title.to_string(),
        updated_at: session.updated_at,
    })
}

// --- Title generation helpers (the LLM call itself lives in main.rs's
// generate_chat_title command, since it needs AppState/Config access the
// same way ai_complete/agent_run do — these are the pure string-handling
// pieces around that call). ---

pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// Strips quoting/whitespace the model sometimes wraps a title in and caps
/// length, so a slightly-too-chatty response doesn't turn into a paragraph-
/// long session title.
pub fn clean_title(raw: &str) -> String {
    let cleaned = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_end_matches('.')
        .trim();
    if cleaned.is_empty() {
        "New Chat".to_string()
    } else {
        truncate_chars(cleaned, 60)
    }
}

/// Used when the title-generation LLM call itself fails (missing "title"
/// *and* "chat" routing, provider error, etc.) — title generation should
/// never be the reason a chat fails to save.
pub fn fallback_title(user_message: &str) -> String {
    let cleaned = user_message.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        "New Chat".to_string()
    } else {
        truncate_chars(&cleaned, 60)
    }
}