//! State Management & File Synchronization (spec §5).
//!
//! "File on Disk is Truth": snapshot the previous content before every
//! write, so revert always has something to restore even across multiple
//! saves. Commit clears the snapshot, accepting the current disk state as
//! final — matches the two keyboard paths described in the spec's
//! Transaction Resolution step.

use std::fs;
use std::path::{Path, PathBuf};

fn history_dir_for(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".anvil").join("history")
}

/// Maps a real file path to its snapshot path inside .anvil/history/,
/// flattening separators so nested files can't collide or require
/// recreating directory structure inside the history cache.
fn snapshot_path_for(workspace_root: &Path, file_path: &Path) -> Result<PathBuf, String> {
    let rel = file_path.strip_prefix(workspace_root).map_err(|_| {
        format!(
            "{} is not inside workspace root {}",
            file_path.display(),
            workspace_root.display()
        )
    })?;
    let flattened = rel.to_string_lossy().replace(['/', '\\'], "__");
    Ok(history_dir_for(workspace_root).join(format!("{}.snapshot", flattened)))
}

/// Snapshot Generation (spec §5 step 1) — copies current on-disk content
/// before it gets overwritten.
pub fn snapshot_before_write(workspace_root: &Path, file_path: &Path) -> Result<(), String> {
    if !file_path.exists() {
        return Ok(()); // new file — nothing to snapshot yet
    }
    let dir = history_dir_for(workspace_root);
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create history dir: {}", e))?;
    let snap_path = snapshot_path_for(workspace_root, file_path)?;
    fs::copy(file_path, &snap_path)
        .map_err(|e| format!("failed to snapshot {}: {}", file_path.display(), e))?;
    Ok(())
}

/// Transaction Resolution — "drop" path. Restores disk content from the
/// snapshot and returns it so the caller can also refresh the editor.
pub fn revert(workspace_root: &Path, file_path: &Path) -> Result<String, String> {
    let snap_path = snapshot_path_for(workspace_root, file_path)?;
    if !snap_path.exists() {
        return Err("no snapshot available to revert to".to_string());
    }
    let content =
        fs::read_to_string(&snap_path).map_err(|e| format!("failed to read snapshot: {}", e))?;
    fs::write(file_path, &content)
        .map_err(|e| format!("failed to restore {}: {}", file_path.display(), e))?;
    Ok(content)
}

/// Transaction Resolution — "commit" path. Clears the snapshot; the current
/// disk state becomes final until the next write.
pub fn commit(workspace_root: &Path, file_path: &Path) -> Result<(), String> {
    let snap_path = snapshot_path_for(workspace_root, file_path)?;
    if snap_path.exists() {
        fs::remove_file(&snap_path).map_err(|e| format!("failed to clear snapshot: {}", e))?;
    }
    Ok(())
}

/// Rename/move support (Phase 7). Relocates an existing snapshot from the
/// old path's location to the new path's, so renaming or moving a file
/// doesn't orphan its revert point (a stale snapshot nobody can reach) or
/// leave `revert` silently finding nothing where a snapshot actually
/// existed. No-op if there's no snapshot for the old path — mirrors
/// snapshot_before_write's "nothing to do yet" no-op for the same reason.
pub fn relocate_snapshot(
    workspace_root: &Path,
    old_path: &Path,
    new_path: &Path,
) -> Result<(), String> {
    let old_snap = snapshot_path_for(workspace_root, old_path)?;
    if !old_snap.exists() {
        return Ok(());
    }
    let new_snap = snapshot_path_for(workspace_root, new_path)?;
    fs::rename(&old_snap, &new_snap)
        .map_err(|e| format!("failed to relocate snapshot for rename: {}", e))?;
    Ok(())
}
