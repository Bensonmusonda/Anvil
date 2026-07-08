# Language Registry Refactor (Phase 5.5)

**Status:** Planned (post-Phase 5)  
**Scope:** Abstract LSP initialization into a language-agnostic registry to enable multi-language support without code duplication.  
**Effort:** ~3 hours  
**Blockers:** None — this does not block current feature work.

---

## Problem

Currently, LSP integration is hardcoded to Rust:

- **Backend:** `src-tauri/src/lsp.rs` spawns `rust-analyzer` directly (line 81)
- **Frontend:** `src/lspClient.js` checks for `.rs` extension and `Cargo.toml` (lines 19, 172)

Adding a second language (Python, Go, etc.) would require:
1. Duplicating LSP spawning logic per language
2. Duplicating language detection per language
3. Copy-pasting completion/hover/diagnostics handlers

By Phase 7, this becomes unmaintainable.

---

## Solution: Language Registry

Introduce a minimal abstraction layer that:
- Detects the active language from workspace files
- Spawns the appropriate LSP server
- Routes completion/hover/diagnostics through a generic handler

This is **additive**—no changes to existing Phase 5 code required. Existing Rust integration remains untouched during implementation.

---

## Backend Changes (Rust)

### New File: `src-tauri/src/language.rs`

```rust
//! Language Registry — abstracts language-specific LSP detection and spawning.
//! Enables multi-language support without duplicating lsp.rs logic.

use crate::tool_registry::ToolDefinition;
use std::path::Path;
use std::process::Child;

/// Metadata about a supported language and its LSP server.
pub struct LanguageConfig {
    /// Display name ("rust", "python", "go")
    pub name: &'static str,
    /// File extensions (".rs", ".py", ".go")
    pub extensions: &'static [&'static str],
    /// LSP binary to spawn ("rust-analyzer", "pylsp", "gopls")
    pub lsp_binary: &'static str,
    /// Optional: LSP binary arguments (e.g., ["--init-command", "..."])
    pub lsp_args: &'static [&'static str],
}

/// Represents files in a workspace root to detect language.
pub struct WorkspaceMetadata {
    pub entries: Vec<String>, // filenames at root level
}

/// Trait: a language that can be detected and has an LSP server.
pub trait LanguageServer {
    /// Detect this language from workspace root files.
    fn detect(&self, ws: &WorkspaceMetadata) -> bool;

    /// Return config for this language's LSP server.
    fn config(&self) -> LanguageConfig;

    /// Spawn the LSP server process for this language.
    fn spawn(&self) -> Result<Child, String> {
        let cfg = self.config();
        std::process::Command::new(cfg.lsp_binary)
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {}", cfg.lsp_binary, e))
    }
}

// ============================================================================
// Language Implementations
// ============================================================================

pub struct RustLanguage;

impl LanguageServer for RustLanguage {
    fn detect(&self, ws: &WorkspaceMetadata) -> bool {
        ws.entries.iter().any(|e| e == "Cargo.toml")
    }

    fn config(&self) -> LanguageConfig {
        LanguageConfig {
            name: "rust",
            extensions: &[".rs"],
            lsp_binary: "rust-analyzer",
            lsp_args: &[],
        }
    }
}

pub struct PythonLanguage;

impl LanguageServer for PythonLanguage {
    fn detect(&self, ws: &WorkspaceMetadata) -> bool {
        ws.entries
            .iter()
            .any(|e| e == "requirements.txt" || e == "setup.py" || e == "pyproject.toml")
    }

    fn config(&self) -> LanguageConfig {
        LanguageConfig {
            name: "python",
            extensions: &[".py"],
            lsp_binary: "pylsp",
            lsp_args: &[],
        }
    }
}

pub struct GoLanguage;

impl LanguageServer for GoLanguage {
    fn detect(&self, ws: &WorkspaceMetadata) -> bool {
        ws.entries.iter().any(|e| e == "go.mod")
    }

    fn config(&self) -> LanguageConfig {
        LanguageConfig {
            name: "go",
            extensions: &[".go"],
            lsp_binary: "gopls",
            lsp_args: &[],
        }
    }
}

// ============================================================================
// Registry
// ============================================================================

/// Detects the active language from workspace root files.
/// Returns the first matching language in priority order.
pub fn detect_language(ws: &WorkspaceMetadata) -> Option<Box<dyn LanguageServer>> {
    // Priority: check Rust first, then Python, then Go
    // (Adjust priority based on your target audience)
    if RustLanguage.detect(ws) {
        Some(Box::new(RustLanguage))
    } else if PythonLanguage.detect(ws) {
        Some(Box::new(PythonLanguage))
    } else if GoLanguage.detect(ws) {
        Some(Box::new(GoLanguage))
    } else {
        None
    }
}

/// Get language config by file extension.
/// Used by frontend to determine syntax highlighting, language ID, etc.
pub fn language_from_extension(path: &str) -> Option<LanguageConfig> {
    let supported_languages: Vec<Box<dyn LanguageServer>> = vec![
        Box::new(RustLanguage),
        Box::new(PythonLanguage),
        Box::new(GoLanguage),
    ];

    for lang in supported_languages {
        if lang.config().extensions.iter().any(|ext| path.ends_with(ext)) {
            return Some(lang.config());
        }
    }
    None
}
```

### Modify: `src-tauri/src/main.rs`

Add to module declaration:
```rust
mod language;
```

Update the `start_lsp` command:

```rust
#[tauri::command]
async fn start_lsp(workspace_root: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    // Detect language from workspace
    let entries: Vec<String> = list_dir(workspace_root.clone())?
        .into_iter()
        .map(|e| e.name)
        .collect();
    
    let ws = language::WorkspaceMetadata { entries };
    let lang = language::detect_language(&ws)
        .ok_or("no supported language detected in workspace")?;
    
    let cfg = lang.config();
    eprintln!("Detected language: {}", cfg.name);
    
    lsp::start(workspace_root, Arc::clone(&state.lsp), app).await
}
```

**No changes to `src-tauri/src/lsp.rs` yet.** The LSP relay logic remains identical. Future work: parameterize `Command::new("rust-analyzer")` to accept the binary name from the language config.

---

## Frontend Changes (JavaScript)

### New File: `src/languages.js`

```javascript
/**
 * Language Registry — metadata about supported languages.
 * Used for detection, syntax highlighting, LSP initialization, and UI labels.
 */

export const languages = [
  {
    id: "rust",
    name: "Rust",
    extensions: [".rs"],
    // Detection: used in maybeStartLsp to decide if LSP should start
    detectFiles: ["Cargo.toml"],
    lspBinary: "rust-analyzer",
    languageIdForLsp: "rust",
  },
  {
    id: "python",
    name: "Python",
    extensions: [".py"],
    detectFiles: ["requirements.txt", "setup.py", "pyproject.toml"],
    lspBinary: "pylsp",
    languageIdForLsp: "python",
  },
  {
    id: "go",
    name: "Go",
    extensions: [".go"],
    detectFiles: ["go.mod"],
    lspBinary: "gopls",
    languageIdForLsp: "go",
  },
];

/**
 * Detect the active language from workspace root entries.
 * Returns the first match in priority order.
 */
export function detectLanguage(entries) {
  for (const lang of languages) {
    if (lang.detectFiles.some(file => entries.some(e => e.name === file))) {
      return lang;
    }
  }
  return null;
}

/**
 * Get language config by file extension.
 * Used to determine syntax highlighting, completions, diagnostics, etc.
 */
export function getLanguageByExtension(filePath) {
  for (const lang of languages) {
    if (lang.extensions.some(ext => filePath.endsWith(ext))) {
      return lang;
    }
  }
  return null;
}

/**
 * Check if a file path is in a supported language.
 */
export function isFileSupported(filePath) {
  return getLanguageByExtension(filePath) !== null;
}
```

### Modify: `src/lspClient.js`

Update imports:
```javascript
import { languages, detectLanguage, getLanguageByExtension, isFileSupported } from "./languages.js";
```

Replace hardcoded Rust checks:
```javascript
// OLD:
export function isRustFile(path) {
  return path && path.endsWith(".rs");
}

// NEW:
export function isRustFile(path) {
  // Backward compat; actually delegates to registry
  return isFileSupported(path);
}
```

Update `maybeStartLsp`:
```javascript
export async function maybeStartLsp(workspaceRoot, entries) {
  // Detect language from workspace files
  const lang = detectLanguage(entries);
  if (!lang) return;

  try {
    await window.__TAURI__.core.invoke("start_lsp", { workspaceRoot });
    currentLanguage = lang;
    lspStarted = true;
    showStatus(`${lang.name} language server started`);
  } catch (err) {
    lspStarted = false;
    showStatus(`${lang.name} language server failed to start: ${err}`, true);
  }
}
```

Update LSP notifications to use dynamic language ID:
```javascript
export async function notifyDidOpen(path, content) {
  if (!lspStarted || !isFileSupported(path)) return;

  if (lspOpenPath === path) return;
  if (lspOpenPath && lspOpenPath !== path) {
    await notifyDidClose(lspOpenPath);
  }

  const lang = getLanguageByExtension(path);
  docVersion = 1;
  try {
    await window.__TAURI__.core.invoke("lsp_notify", {
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: pathToUri(path),
          languageId: lang?.languageIdForLsp || "unknown",  // Was hardcoded "rust"
          version: docVersion,
          text: content,
        },
      },
    });
    lspOpenPath = path;
  } catch (err) {
    console.error("didOpen failed:", err);
  }
}
```

---

## Testing Checklist

Once implemented, verify:

- [ ] Rust project detection still works (workspace with `Cargo.toml`)
- [ ] Rust LSP completion/hover/diagnostics still work
- [ ] Python project detection works (workspace with `requirements.txt`)
- [ ] Python LSP completion/hover/diagnostics work
- [ ] Go project detection works (workspace with `go.mod`)
- [ ] Go LSP completion/hover/diagnostics work
- [ ] Opening a file in an unsupported language doesn't crash LSP
- [ ] Switching between workspaces switches LSP servers correctly

---

## Future Extensions

### Adding a New Language (e.g., TypeScript)

1. **Backend:** Add to `src-tauri/src/language.rs`:
   ```rust
   pub struct TypeScriptLanguage;
   impl LanguageServer for TypeScriptLanguage { ... }
   ```

2. **Frontend:** Add to `src/languages.js`:
   ```javascript
   { id: "typescript", name: "TypeScript", extensions: [".ts", ".tsx"], detectFiles: ["package.json"], lspBinary: "typescript-language-server", languageIdForLsp: "typescript" }
   ```

3. **Registry:** Update `detect_language()` / `detectLanguage()` to include the new language.

**Time: ~30 minutes per language.**

### Custom LSP Arguments

Some LSP servers need arguments. Extend `LanguageConfig.lsp_args` usage in `src-tauri/src/lsp.rs`:

```rust
fn spawn(&self) -> Result<Child, String> {
    let cfg = self.config();
    let mut cmd = std::process::Command::new(cfg.lsp_binary);
    for arg in cfg.lsp_args {
        cmd.arg(arg);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to spawn {}: {}", cfg.lsp_binary, e))
}
```

### Custom Language-Specific Tools

Once this is in place, you can add language-specific native tools:

```rust
// In src-tauri/src/tools_native.rs
fn definitions() -> Vec<ToolDefinition> {
    let mut tools = vec![
        // ... existing read_file, write_file ...
    ];
    
    // Add language-specific tools based on currentLanguage
    if let Some(lang) = CURRENT_LANGUAGE.lock().unwrap().as_ref() {
        match lang.id {
            "rust" => tools.extend(rust_tools()),
            "python" => tools.extend(python_tools()),
            "go" => tools.extend(go_tools()),
            _ => {}
        }
    }
    
    tools
}

fn rust_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "run_cargo_check".into(),
            description: "Run `cargo check` in the workspace and return output.".into(),
            // ...
        },
    ]
}
```

---

## Notes

- **No breaking changes:** This refactor is purely additive. Existing Rust support continues to work as-is during and after implementation.
- **Phase 5 unaffected:** Ship Rust LSP support first. Do this refactor afterward when you have a second language in mind.
- **Config-driven future:** Once the registry is stable, you could move language definitions to `~/.anvil/languages.json` for user customization.
- **MCP integration:** Language-specific extensions (e.g., `rust-clippy-mcp`) can read the detected language from config and enable themselves conditionally.

---

## Diff Preview (Not to be implemented now)

When you're ready, the minimal changeset will look like:

```diff
src-tauri/src/main.rs
  + mod language;
  ~ update start_lsp() to use detect_language()

src-tauri/src/language.rs (NEW)
  + ~150 lines: trait + implementations + registry

src/lspClient.js
  - isRustFile() → isFileSupported()
  - hardcoded "rust" languageId → lang.languageIdForLsp

src/languages.js (NEW)
  + ~80 lines: language definitions + helpers
```

**Total lines changed:** ~250 (all in new/abstraction files; no churn in existing logic).
