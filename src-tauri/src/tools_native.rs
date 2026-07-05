//! Native tools: read_file, write_file (spec §4 table). write_file reuses
//! the Phase 3 snapshot mechanism so agent-driven edits get the same
//! revert/commit safety net as manual saves.

use crate::history;
use crate::tool_registry::{ToolDefinition, ToolOrigin};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "read_file".into(),
            description: "Read the full text content of a file at the given absolute path.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" }
                },
                "required": ["path"]
            }),
            origin: ToolOrigin::Native,
        },
        ToolDefinition {
            name: "write_file".into(),
            description: "Write text content to a file at the given absolute path. The previous content is snapshotted first, so it can be reverted from the editor's Revert button.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "content": { "type": "string", "description": "New full content to write" }
                },
                "required": ["path", "content"]
            }),
            origin: ToolOrigin::Native,
        },
    ]
}

/// Executes a native tool by name. `workspace_root` is optional because a
/// write can technically target a file outside any open workspace — in
/// that case we skip snapshotting (nothing to make relative to) rather
/// than fail the whole write.
pub fn execute(name: &str, args: &Value, workspace_root: Option<&Path>) -> Result<String, String> {
    match name {
        "read_file" => {
            let path = args["path"].as_str().ok_or("missing \"path\" argument")?;
            fs::read_to_string(path).map_err(|e| format!("failed to read {}: {}", path, e))
        }
        "write_file" => {
            let path = args["path"].as_str().ok_or("missing \"path\" argument")?;
            let content = args["content"].as_str().ok_or("missing \"content\" argument")?;
            let file_path = Path::new(path);

            if let Some(root) = workspace_root {
                if file_path.starts_with(root) {
                    // Best-effort: a failed snapshot shouldn't block the
                    // write itself, just means revert won't be available.
                    let _ = history::snapshot_before_write(root, file_path);
                }
            }

            fs::write(file_path, content).map_err(|e| format!("failed to write {}: {}", path, e))?;
            Ok(format!("wrote {} bytes to {}", content.len(), path))
        }
        other => Err(format!("unknown native tool \"{}\"", other)),
    }
}
