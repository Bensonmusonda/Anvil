// Full-text content search across a workspace directory tree.
// Used by the `search_in_files` Tauri command.
//
// Design decisions:
// - Reuses the `ignore` WalkBuilder (same settings as fuzzy.rs) so that
//   .gitignore, hidden files and common noise dirs are all filtered out.
// - Files that are not valid UTF-8 are silently skipped — they are almost
//   always binary blobs (images, compiled outputs) that have no meaningful
//   text content to search.
// - A hard cap of MAX_MATCHES results is applied before returning so the
//   frontend is never handed an unbounded list.

use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::path::Path;

const MAX_MATCHES: usize = 1_000;
/// Snippet lines are capped at this many chars before being truncated with "…"
const MAX_SNIPPET_CHARS: usize = 120;

#[derive(Debug, Serialize, Clone)]
pub struct SearchMatch {
    /// Absolute path to the file containing this match.
    pub path: String,
    /// 1-indexed line number of the match within the file.
    pub line_number: usize,
    /// 0-indexed byte offset of the first character of the match on its line.
    pub column: usize,
    /// A (possibly truncated) copy of the matching line for display.
    pub line_content: String,
}

/// Search all text files under `root` for `query`.
///
/// - `case_sensitive`: when false, matching ignores ASCII case.
/// - `use_regex`: when true, `query` is compiled as a regex; when false it is
///   treated as a plain literal (special regex characters are escaped).
///
/// Returns up to `MAX_MATCHES` results. The caller can detect truncation by
/// checking whether the returned `Vec` has exactly that many entries.
pub fn search_files(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    // Build the pattern. Escape the query for literal mode so characters like
    // `.` or `*` are matched verbatim rather than interpreted as regex syntax.
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid regex: {e}"))?;

    let mut matches = Vec::new();

    let walker = WalkBuilder::new(root)
        .hidden(true)     // skip dotfiles / hidden dirs
        .git_ignore(true) // respect .gitignore
        .build();

    'files: for entry in walker.flatten() {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }

        let content = match std::fs::read_to_string(entry.path()) {
            Ok(s) => s,
            Err(_) => continue, // binary or unreadable file — skip silently
        };

        for (zero_idx, line) in content.lines().enumerate() {
            if let Some(m) = re.find(line) {
                let snippet = if line.chars().count() > MAX_SNIPPET_CHARS {
                    let truncated: String = line.chars().take(MAX_SNIPPET_CHARS).collect();
                    format!("{truncated}…")
                } else {
                    line.to_string()
                };

                matches.push(SearchMatch {
                    path: entry.path().to_string_lossy().into_owned(),
                    line_number: zero_idx + 1, // 1-indexed for the editor
                    column: m.start(),
                    line_content: snippet,
                });

                if matches.len() >= MAX_MATCHES {
                    break 'files;
                }
            }
        }
    }

    Ok(matches)
}
