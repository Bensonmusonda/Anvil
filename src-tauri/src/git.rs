use serde::Serialize;
use std::process::Command;
use std::path::Path;

#[derive(Serialize)]
pub struct GitStatus {
    pub path: String,
    pub status: String,
}

/// Run `git status --porcelain` and parse the results.
pub fn status(cwd: &Path) -> Result<Vec<GitStatus>, String> {
    let output = Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to execute git status: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", err));
    }

    let out_str = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in out_str.lines() {
        if line.len() > 3 {
            let status = line[0..2].to_string();
            let path = line[3..].trim().to_string();
            results.push(GitStatus { path, status });
        }
    }

    Ok(results)
}

/// Run `git diff <path>` to get changes for a file.
pub fn diff(cwd: &Path, path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .arg("diff")
        .arg("HEAD")
        .arg("--")
        .arg(path)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to execute git diff: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff failed: {}", err));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run `git add <path>`
pub fn stage(cwd: &Path, path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .arg("add")
        .arg("--")
        .arg(path)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to execute git add: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {}", err));
    }
    Ok(())
}

/// Run `git reset HEAD <path>`
pub fn unstage(cwd: &Path, path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .arg("reset")
        .arg("HEAD")
        .arg("--")
        .arg(path)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to execute git reset: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git reset failed: {}", err));
    }
    Ok(())
}

/// Run `git commit -m <message>`
pub fn commit(cwd: &Path, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .arg("commit")
        .arg("-m")
        .arg(message)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to execute git commit: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {}", err));
    }
    Ok(())
}
