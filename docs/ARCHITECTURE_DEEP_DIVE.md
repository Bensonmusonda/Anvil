# Anvil Architecture Deep Dive — Code Review Checklist

**Purpose:** A line-by-line walkthrough of Anvil's systems architecture. As you review each section, check off the boxes to confirm you understand the design, assumptions, and failure modes.

**When to use this:** After you've written Phase 7 (or any phase), use this to review the code and catch your own gaps in understanding before pushing.

---

## 0. Pre-Review Orientation

Before diving into code, ground yourself in the big picture.

### 0.1 The Core Constraint: "File on Disk is Truth"

- [ ] I understand that Anvil doesn't have a traditional in-memory buffer model
- [ ] Reads always come from disk (via `fs::read_to_string`)
- [ ] Writes always go to disk immediately (via `fs::write`)
- [ ] The frontend watches for filesystem changes and reloads from disk
- [ ] Implications: No unsaved-state tracking, no "save" button needed (yet), simpler undo (snapshots)
- [ ] **Question to self:** What breaks if disk write fails? (Answered: error propagates to frontend status bar)

### 0.2 The IPC Boundary

- [ ] Frontend (JS) can only call Tauri `#[tauri::command]` functions
- [ ] Tauri commands are async-capable and return `Result<T, String>`
- [ ] The Rust side owns all I/O, config, LSP, agents, file watching
- [ ] Frontend is purely view/event layer
- [ ] **Question to self:** What happens if a Tauri command panics? (Crashes the whole app; should never happen in production code)

### 0.3 The Phase Layers (What You've Built)

- [ ] Phase 0–2: Skeleton, routing, editor surface (✅ done)
- [ ] Phase 3: AI-in-editor, watcher, snapshot/revert/commit (✅ done)
- [ ] Phase 4: Agent tool-calling + MCP (✅ done)
- [ ] Phase 5: LSP integration (✅ done)
- [ ] Phase 6–6.5: Polish, modularization (✅ done)
- [ ] Phase 7: CRUD operations (on branch, partially pushed)
- [ ] **Your mental model:** Each phase stands alone, doesn't depend on visual polish from later phases

---

## 1. Frontend Architecture (`src/`)

### 1.1 Module Dependency Graph

**Leaf modules (no dependencies except `state.js`):**
- [ ] `state.js` — app state holder, `showStatus()` function
- [ ] `promptDialog.js` — modal replacement for `window.prompt()`
- [ ] `emptyState.js` — toggles welcome overlay

**Mid-level modules (depend on above):**
- [ ] `editorSetup.js` — owns the single `EditorView` instance, created via factory (not at module load) to avoid circular deps
- [ ] `languages.js` — language detection and file-extension mapping (NEW for Phase 5.5 plan)

**High-level modules (glue code):**
- [ ] `lspClient.js` — all LSP logic; has intentional circular import with `fileOps.js`
- [ ] `fileOps.js` — file I/O: open/save/revert/commit; also listens to watcher
- [ ] `fileTree.js` — sidebar; workspace opening; file creation UI
- [ ] `commandPalette.js` — most connected module; dispatches to almost everything else
- [ ] `terminalPanel.js`, `gitPanel.js`, `agentPanel.js`, `aiPanel.js` — feature panels
- [ ] `uiChrome.js` — titlebar, window controls, sidebar tabs

**The composition root:**
- [ ] `main.js` — 45 lines: gathers extensions from modules, calls `createEditor()`, wires up all init bindings
- [ ] **Question to self:** Why is editor created in `main.js` not `editorSetup.js`? (Circular dependency risk; better to construct late)

### 1.2 State Flow: How Data Moves

**Opening a file:**
```
User clicks file in tree
  → fileTree.js calls fileOps.js:openFile(path)
    → fileOps.js calls tauri command read_text_file(path)
      → Rust reads disk
        → Returns content
          → fileOps.js calls editorSetup.js:setEditorContent(content, path)
            → Updates appState.currentFilePath
              → lspClient.js:notifyDidOpen(path, content)
                → Sends didOpen to rust-analyzer
                  → Rust relays to LSP process
                    → LSP indexes the file
```

- [ ] I can trace this flow
- [ ] I understand each step's responsibility
- [ ] I know where errors can occur (Rust FS, LSP spawn, etc.)
- [ ] I know what happens if `read_text_file` fails (error shown in status bar)
- [ ] I know what happens if LSP fails (status bar, no completions, but file still editable)

**Watching for external changes:**
```
External edit (e.g., touch file.rs from terminal)
  → Rust's notify watcher fires
    → Sends IPC event: file-changed → file path
      → fileOps.js listens to this event
        → Calls tauri command read_text_file(path)
          → Updates editor if path === currentFilePath
          → fileTree.js re-renders to show updated timestamp
```

- [ ] I understand the watcher filter (excludes pure Access events)
- [ ] I know what `suppressNextReload` does (prevents double-reload if we triggered the change)
- [ ] I know what happens if the file was deleted externally (editor shows stale content until user clicks away)

### 1.3 The Circular Import Safety Net

**The "unsafe" circular import:**
- [ ] `lspClient.js` imports `openFile` from `fileOps.js`
- [ ] `fileOps.js` imports `notifyDidOpen` from `lspClient.js`
- [ ] **Why it's safe:** Both modules only call each other's functions *inside event handlers*, not at module load
- [ ] **Why it's needed:** `goToDefinition` needs to open files across the project; `didOpen` needs to notify LSP when a file opens
- [ ] **Gotcha:** If either module called the other at import time, this would hang. Don't "fix" this by reorganizing; it's intentional.

- [ ] I won't accidentally break this by moving function calls to module level
- [ ] I understand why the previous version (separate listeners on the same click) was a bug

### 1.4 The Terminal and Git Panels (Fire-and-Forget)

**Terminal:**
- [ ] `terminalPanel.js` renders the xterm.js DOM container
- [ ] Calls `spawn_terminal(cwd)` Tauri command once
- [ ] Rust spawns a PTY via `portable-pty`
- [ ] Frontend sends input via `write_terminal(data)` and `resize_terminal(rows, cols)`
- [ ] Rust buffers and writes to PTY stdin
- [ ] PTY stdout → Rust collects → emits via Tauri event → xterm.js renders
- [ ] **Question:** What happens if terminal crashes? (Rust catches it, frontend sees no output)

**Git:**
- [ ] `gitPanel.js` calls `git_status()` on demand (refresh button, workspace open)
- [ ] Rust shells out to system `git` — no git library, pure CLI
- [ ] Results come back as JSON-serialized `GitStatus` objects
- [ ] UI renders status/stage/unstage buttons
- [ ] **Question:** What if git isn't installed? (Command fails, error in status bar)

- [ ] I understand why these are separate panels, not integrated
- [ ] I know they don't block each other (both async, both fire-and-forget)

---

## 2. Rust Architecture (`src-tauri/src/`)

### 2.1 The Single Process Model

**Original spec:** Daemon as separate OS process.  
**What actually happened:** Folded daemon logic into Tauri host in Phase 3.  
**Why:** Simpler IPC (Tauri commands), no separate process to manage, same memory space for state.

- [ ] I understand this was a deliberate trade-off (simplicity vs. isolation)
- [ ] I know the downside: one crash = whole app (but this is okay for an editor)
- [ ] I know the upside: no inter-process plumbing, easier to debug

### 2.2 AppState: The Single Source of Truth

```rust
struct AppState {
    config: Mutex<Option<Config>>,
    workspace_root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    lsp: Arc<LspState>,
    terminal: TerminalState,
}
```

- [ ] `config` is loaded lazily on first AI command, then cached (no hot-reload)
- [ ] `workspace_root` is set when user opens a folder
- [ ] `watcher` is created when workspace opens, fires events for external changes
- [ ] `lsp` is shared across threads via Arc; lives in its own module (`lsp.rs`)
- [ ] `terminal` holds PTY state

**Questions to self:**
- [ ] Why is `config` `Mutex<Option<>>` instead of just `Mutex<Config>`? (Lazy init; config loading can fail)
- [ ] What happens if two commands try to read config simultaneously? (Mutex blocks one until the other finishes; this is fine)
- [ ] What happens if config is wrong (invalid JSON, missing keys)? (Error bubbles to frontend status bar; user can't use AI until fixed)

### 2.3 The Config Cascade

**File:** `src-tauri/src/config.rs`

```rust
pub struct Config {
    pub providers: HashMap<String, ProviderConfig>,
    pub routing: HashMap<String, RouteConfig>,
    pub mcp_servers: HashMap<String, McpServerConfig>,
    pub extensions: ExtensionsConfig,  // Reserved for Phase 7+
    pub auto_save: bool,
    pub theme: String,
}
```

- [ ] Providers define API keys + base URLs (Ollama, DeepSeek, OpenRouter)
- [ ] Routing defines which provider to use for each "purpose" (chat, inline, etc.)
- [ ] MCP servers are child processes that Anvil spawns on demand
- [ ] Extensions config is reserved (not yet used)
- [ ] Auto-save is reserved (not yet used; currently all saves are manual)
- [ ] Theme is used to set CSS class on root element

**Validation:**
- [ ] I understand why `validate()` checks that routing references known providers
- [ ] I understand why a missing provider in routing is a hard error (better to fail than silently fallback)

**Resolution:**
- [ ] `resolve_api_key()` checks if key starts with `ENV_` (indirect env var reference)
- [ ] Example: `"api_key": "ENV_DEEPSEEK_API_KEY"` → reads `$DEEPSEEK_API_KEY` at runtime
- [ ] **Question:** What if env var isn't set? (Error with clear message; user needs to set it)

### 2.4 Provider Routing: The AI Backbone

**File:** `src-tauri/src/provider.rs`

```rust
pub async fn complete(config: &Config, purpose: &str, prompt: &str) -> Result<String, String>
```

- [ ] Looks up `routing[purpose]` to find which provider to use
- [ ] Constructs OpenAI-compatible JSON (model, messages, stream=false)
- [ ] Sends HTTP POST via `reqwest`
- [ ] Parses response: `choices[0].message.content`
- [ ] Returns text or error

**Error handling:**
- [ ] Missing purpose in routing → clear error ("no routing configured for purpose X")
- [ ] Unknown provider → clear error
- [ ] HTTP error (network, auth, server error) → includes status code and response
- [ ] Non-JSON response → includes the bad response in error (helps debugging)

- [ ] I understand why we don't retry on network errors (editor should handle that, not provider)
- [ ] I understand why we force `stream: false` for now (streaming is Phase 3+ work)
- [ ] I understand why this is async (blocks the webview otherwise)

### 2.5 The Snapshot/Revert/Commit Cycle

**File:** `src-tauri/src/history.rs`

```rust
pub fn snapshot_before_write(root: &Path, file_path: &Path) -> Result<(), String>
pub fn revert(root: &Path, file_path: &Path) -> Result<String, String>
pub fn commit(root: &Path, file_path: &Path) -> Result<(), String>
```

**How it works:**
1. **Snapshot:** Before user saves a file, copy current disk content to `.anvil/history/{hash}/`
2. **Revert:** Restore from snapshot (if one exists)
3. **Commit:** Delete the snapshot (accept current state as final)

**Key design:**
- [ ] Snapshots are per-file, stored by a hash of the file path (deterministic)
- [ ] Snapshots are only created if the file already exists (new files skip this)
- [ ] Multiple snapshots can exist (one per save cycle)
- [ ] Revert uses the *latest* snapshot (LIFO, not a full version history)

**Questions to self:**
- [ ] What if snapshot creation fails? (Error propagates; save is blocked — right, because we can't guarantee revert works)
- [ ] What if the snapshot directory is corrupted? (Error; user is told revert unavailable)
- [ ] What if I save a file 10 times? (10 snapshots stack up; commit clears them all)
- [ ] What happens to snapshots when I delete a file? (They're orphaned; Phase 7 `delete_path` needs to clean them up)

- [ ] I understand the "file on disk is truth" consequence: snapshots are undo, not version history
- [ ] I won't confuse this with Git versioning (it's lighter, faster, per-file)

### 2.6 Tool Registry: The Unified Schema

**File:** `src-tauri/src/tool_registry.rs`

```rust
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,  // JSON schema
    pub origin: ToolOrigin,  // Native or MCP
}

pub fn to_openai_tool(&self) -> Value  // Converts to OpenAI function-calling format
```

- [ ] Every tool (native or MCP) is described identically
- [ ] `to_openai_tool()` is the *one place* tools are converted to API format
- [ ] Agent doesn't care about origin; it only cares about `name` and `parameters`

**Questions to self:**
- [ ] Why is `parameters` a generic `Value`? (Flexibility; each tool defines its own schema)
- [ ] What if a tool definition is malformed? (Should be caught at definition time, not dispatch time)
- [ ] Why are native and MCP tools in the same registry? (Single source of truth for agents; easier for LLM to reason about)

### 2.7 Native Tools: read_file, write_file

**File:** `src-tauri/src/tools_native.rs`

```rust
pub fn execute(name: &str, args: &Value, workspace_root: Option<&Path>) -> Result<String, String>
```

**read_file:**
- [ ] Takes absolute path, returns full content
- [ ] No size limit yet (should add 5MB limit; gotcha for large binaries)

**write_file:**
- [ ] Takes absolute path and content
- [ ] Calls `history::snapshot_before_write()` first (if workspace is open)
- [ ] Then writes to disk
- [ ] Watcher fires, frontend reloads

**Questions to self:**
- [ ] What if agent calls `write_file` on a file outside the workspace? (Snapshot is skipped, file is still written — intentional)
- [ ] What if `write_file` content is huge (1GB)? (Should fail gracefully; currently no limit)
- [ ] What if two agents try to write the same file? (Rust's FS handles it; last write wins — okay for now)

### 2.8 MCP Host: Bridging to Third-Party Tools

**File:** `src-tauri/src/mcp_host.rs`

```rust
pub async fn list_tools(command: &str, args: &[String]) -> Result<Vec<ToolDefinition>, String>
pub async fn call_tool(command: &str, args: &[String], tool_name: &str, tool_args: Value) -> Result<String, String>
```

**How it works:**
1. Spawn MCP server as child process
2. Connect via `rmcp` crate (official MCP SDK)
3. Call `list_all_tools()` to discover tools
4. Convert MCP tool schema to `ToolDefinition`
5. On agent dispatch, spawn a fresh connection, call the tool, return result

**Design decision: Fresh connection per call, not persistent.**
- [ ] Why? Simpler state management; no need to track connection lifecycle
- [ ] Downside? Slightly slower (spawn + connect overhead); Phase 3+ can optimize this

**Questions to self:**
- [ ] What if MCP server crashes mid-call? (Error propagates to agent; agent can retry or fail gracefully)
- [ ] What if MCP server returns invalid JSON? (Parsing fails; error to agent)
- [ ] What if there's no MCP server configured but agent tries to call MCP tool? (Clear error: "no MCP server configured")

### 2.9 Agent Loop: The Brain

**File:** `src-tauri/src/agent.rs`

```rust
pub async fn run(
    config: &Config,
    prompt: &str,
    tools: &[ToolDefinition],
    workspace_root: Option<&Path>,
    mcp_command: Option<(&str, &[String])>,
) -> Result<String, String>
```

**Loop logic:**
1. Send prompt + tools to LLM (e.g., DeepSeek)
2. If LLM returns text (no `tool_calls`), return it
3. If LLM returns `tool_calls`, execute each one
4. Add results back to message history as `role: tool`
5. Loop back to step 1
6. Stop after `MAX_ITERATIONS` (safety net)

**Questions to self:**
- [ ] Why do we send the full tool list each iteration? (Simplicity; LLM needs full context)
- [ ] What if LLM calls a tool that doesn't exist? (Error caught; added to message history; LLM should fix)
- [ ] What if a tool fails? (Error message sent back to LLM; LLM can retry or give up)
- [ ] Why MAX_ITERATIONS limit? (Prevent infinite loops if LLM gets stuck)

- [ ] I understand this is basic ReAct pattern (Reason + Act)
- [ ] I understand why we don't stream responses (Phase 3+ feature)

### 2.10 LSP Integration: rust-analyzer Relay

**File:** `src-tauri/src/lsp.rs`

**Spawning:**
```rust
let mut child = Command::new("rust-analyzer")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
```

- [ ] One LSP process per workspace (not per file)
- [ ] Killed when workspace changes or app closes (implicit)
- [ ] Stderr relayed to stderr (helps debugging)
- [ ] Stdout/stdin used for JSON-RPC protocol

**JSON-RPC Framing:**
- [ ] Hand-rolled, not a dependency (protocol is small enough)
- [ ] Format: `Content-Length: {n}\r\n\r\n{json body}`
- [ ] **Gotcha:** `\r\n` not just `\n` (LSP spec is strict)

- [ ] I understand why we parse this manually (protocol is stable; simpler than a dependency)

**Message Dispatch:**
```
Frontend sends textDocument/completion
  → wrapped in JSON-RPC envelope with id=42
    → Rust sends to rust-analyzer via stdin
      → rust-analyzer responds with id=42
        → Rust looks up id in pending map
          → Sends to waiting frontend request
            → Frontend unwraps result and returns completion list
```

- [ ] I understand the `pending` map (tracks outstanding requests by id)
- [ ] I understand why we unwrap the `result` field before returning to frontend (fixes the hover/completion bug)
- [ ] I understand why we acknowledge server-initiated requests (prevents server from stalling)

**Gotchas caught in Phase 5:**
- [ ] Duplicate `DidOpenTextDocument` errors (needed to track currently-open file)
- [ ] Missing acknowledgment of `workspace/diagnostic/refresh` (server was stalling)
- [ ] JSON-RPC envelope not unwrapped (hover/completion returned empty)
- [ ] Autocomplete re-ranked by CodeMirror (needed to preserve rust-analyzer's `sortText`)

- [ ] I won't re-introduce these bugs in Phase 8+

### 2.11 Filesystem Watcher: External Change Detection

**File:** `src-tauri/src/main.rs` (command `start_watching`)

```rust
let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    if let Ok(event) = res {
        if !matches!(event.kind, notify::EventKind::Access(_)) {
            for changed_path in event.paths {
                let _ = app_handle.emit("file-changed", changed_path);
            }
        }
    }
})
```

- [ ] Watches from workspace root recursively
- [ ] Filters out `Access` events (read-only, noise)
- [ ] Emits `file-changed` IPC event for each change
- [ ] Frontend listens and reloads if current file changed

**Why not Modify/Create/Remove only?**
- [ ] Some editors write temp file + rename (emits Create + Remove, not Modify)
- [ ] Catching everything except Access is safer

- [ ] I understand why we DON'T reload on Access (would thrash on file opens)
- [ ] I understand why we emit per-file (frontend only reloads current file)

---

## 3. Phase 7 Deep Dive: CRUD Operations

### 3.1 Create File/Folder

**Rust side (`main.rs`):**
```rust
#[tauri::command]
fn create_file(parent_dir: String, name: String) -> Result<String, String>

#[tauri::command]
fn create_folder(parent_dir: String, name: String) -> Result<String, String>
```

- [ ] Validates name (no slashes, not empty)
- [ ] Creates empty file/folder via `fs::create_dir`, `fs::OpenOptions`
- [ ] Returns the full path (so frontend can select it in tree)
- [ ] Does NOT snapshot (file doesn't exist yet, so nothing to revert)

**Frontend side (`fileTree.js`):**
- [ ] User right-clicks folder or empty space → context menu
- [ ] Menu shows "New File", "New Folder"
- [ ] Clicking calls tauri command with parent_dir
- [ ] Result path is selected in tree
- [ ] If no workspace open, shows themed prompt to name the file/folder, then opens it as a workspace

**Questions to self:**
- [ ] What if name already exists? (Error: "file or folder already exists")
- [ ] What if parent_dir doesn't exist? (Error: "parent directory doesn't exist")
- [ ] What if permissions are denied? (Error: propagated from FS)
- [ ] Why does no-workspace creation auto-open the result? (Because save/revert require workspace_root)

### 3.2 Delete File/Folder

**Rust side (`main.rs`):**
```rust
#[tauri::command]
fn delete_path(path: String) -> Result<(), String>  // Uses trash crate

#[tauri::command]
fn delete_path_permanent(path: String) -> Result<(), String>  // Permanent rm
```

- [ ] Delete (trash): sends to system trash (recoverable)
- [ ] Delete permanent: calls `std::fs::remove_file` / `std::fs::remove_dir_all` (gone forever)
- [ ] Both should clean up any snapshots in `.anvil/history/` (Phase 7 to implement)

**Frontend side (`fileTree.js`):**
- [ ] Right-click → Delete (sends to trash)
- [ ] Edit menu → Delete Permanently (with confirmation)
- [ ] If user deletes the currently-open file, editor should clear

**Questions to self:**
- [ ] Why two commands? (Trash is reversible; permanent is irreversible; UI should make this clear)
- [ ] What if user deletes the open file? (Should call `closeFile()` in editor; watcher will notice file gone)
- [ ] What if deletion fails halfway (e.g., remove_dir_all on a huge folder)? (Error; user sees status message; orphaned files might remain)

### 3.3 Rename File/Folder

**Rust side (`main.rs`):**
```rust
#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<String, String>
```

- [ ] Validates new name (no slashes, not empty)
- [ ] Validates new parent exists
- [ ] Calls `history::relocate_snapshot()` before rename (moves `.anvil/history/{old}` to `.anvil/history/{new}`)
- [ ] Calls `fs::rename()` to move the file
- [ ] Returns new path (so frontend can re-select it)
- [ ] If currently-open file is renamed, frontend gets watcher event and reloads

**Questions to self:**
- [ ] Why relocate snapshot before rename? (Keeps snapshot in sync with file; if rename fails, snapshot is already moved back if needed)
- [ ] What if rename fails after snapshot relocation? (Snapshot is orphaned; Phase 7 to document this risk)
- [ ] What if the file is open in the editor when renamed? (Watcher fires `file-changed`, frontend reloads from new path)
- [ ] What if rename crosses directories? (Same; snapshot and file both move)

### 3.4 Recent Workspaces & No-Workspace Fallback

**Rust side (`main.rs`):**
```rust
#[tauri::command]
fn get_recent_workspaces() -> Result<Vec<String>, String>

#[tauri::command]
fn add_recent_workspace(path: String) -> Result<(), String>
```

- [ ] Stored in `~/.anvil/recent_workspaces.json` (same pattern as config)
- [ ] Stored as ordered list, max 10 items
- [ ] Accessed when workspace is opened (add to recent)
- [ ] Accessed when app starts (show in welcome screen)

**No-workspace creation:**
- [ ] User clicks "New File" when no workspace is open
- [ ] Frontend shows native file picker (save dialog)
- [ ] User picks a location and name
- [ ] Rust creates the file
- [ ] Rust creates the parent directory as a workspace and opens it
- [ ] Frontend now has workspace_root; everything else works

- [ ] I understand why we need this fallback (save/revert/commit all need workspace_root)
- [ ] I understand why we use native dialogs (familiar to users, handles path picking)

---

## 4. Cross-Cutting Concerns

### 4.1 Error Handling

**Principle:** All Rust errors should convert to `Result<T, String>` and propagate as human-readable messages.

- [ ] I never use `unwrap()` in production code
- [ ] I never use `panic!()` except in unrecoverable bugs (and document why)
- [ ] Errors include context ("failed to read {path}: {reason}")
- [ ] Errors are returned to frontend via Tauri's Result mechanism
- [ ] Frontend shows errors in status bar (yellow/red, temporary or persistent)

**Questions to self:**
- [ ] What if a Tauri command panics? (App crashes; should never happen)
- [ ] What if an error message is misleading? (User can't debug their own setup; bad UX)

### 4.2 Mutexes and Arc

**Used sparingly:**
- [ ] `AppState` fields are wrapped in `Mutex` (need to be mutable across commands)
- [ ] `lsp::LspState` is wrapped in `Arc<Mutex>` (shared across relay threads)
- [ ] `terminal::TerminalState` is wrapped in `Mutex` (PTY handle is mutable)

**Questions to self:**
- [ ] Why not use RwLock? (Tauri commands are async; Mutex is simpler, contention is low)
- [ ] What if a Mutex is held for too long? (Blocks other commands; should be fast)
- [ ] What if a Mutex is poisoned (panic inside)? (Current code doesn't handle this; Phase 7+ should add panic recovery)

### 4.3 Async/Await

**Tauri commands are async-capable:**
```rust
#[tauri::command]
async fn agent_run(prompt: String, state: State<'_, AppState>) -> Result<String, String>
```

- [ ] Long-running commands are async (provider calls, agent loops, LSP init)
- [ ] Fast commands can be sync (file operations, config reads)
- [ ] Frontend awaits all commands regardless (Tauri handles both)

**Questions to self:**
- [ ] Can two long-running commands run simultaneously? (Yes, in different tokio tasks)
- [ ] What if user runs agent_run twice? (Both run concurrently; whoever finishes first updates UI)
- [ ] Is this a problem? (Probably not for Phase 7; Phase 8+ should add run-state tracking)

---

## 5. Checklist: Am I Ready to Code Phase 8?

Before starting a new phase, confirm you understand the systems you'll interact with.

### 5.1 Frontend Systems
- [ ] I understand the module dependency graph and why circular imports are sometimes safe
- [ ] I can trace state flow from user action → Tauri command → frontend update
- [ ] I know the difference between `appState` mutations and DOM updates
- [ ] I understand the watcher event flow and the `suppressNextReload` guard
- [ ] I can explain what happens if a Tauri command fails
- [ ] I know where errors surface (status bar, mostly)

### 5.2 Rust Systems
- [ ] I understand the single-process model and why it was chosen
- [ ] I can explain AppState fields and why they're Mutex'd
- [ ] I understand config cascading (providers → routing)
- [ ] I can trace the AI flow (provider → agent loop → tool dispatch)
- [ ] I understand how LSP relay works (JSON-RPC framing, pending map, envelope unwrapping)
- [ ] I know the snapshot/revert/commit cycle and its limitations
- [ ] I can explain MCP host design (fresh connection per call)

### 5.3 Cross-System Integration
- [ ] I understand the IPC boundary (frontend = view, Rust = logic)
- [ ] I can trace a multi-step flow (e.g., open file → detect language → spawn LSP → completion)
- [ ] I know where data is lost if a command fails (none; all errors are propagated)
- [ ] I understand the watcher → reload flow and edge cases

### 5.4 Phase 7 Specifics
- [ ] I understand create/delete/rename and their edge cases
- [ ] I know why snapshots matter for rename
- [ ] I know what happens if operations fail halfway
- [ ] I understand the no-workspace fallback
- [ ] I can explain recent workspaces storage

### 5.5 Known Gotchas (From Phases 0–7)
- [ ] I've read the Gotchas Log in ANVIL_PROJECT_TRACKER.md
- [ ] I won't re-introduce the LSP envelope bug
- [ ] I won't re-introduce the duplicate DidOpenTextDocument bug
- [ ] I won't forget to handle external watcher events
- [ ] I understand why atomic file saves + watching needs care

---

## 6. Graduation: You're Ready When...

- [ ] You can explain the core constraint ("file on disk is truth")
- [ ] You can trace any feature flow end-to-end
- [ ] You can explain why each major design decision was made
- [ ] You can list the Gotchas and why each happened
- [ ] You can sketch the module dependency graph from memory
- [ ] You understand what breaks if each system fails
- [ ] You've read all of `src-tauri/src/*.rs` (not just skimmed)
- [ ] You've read all of `src/*.js` (not just skimmed)
- [ ] You can write a new phase without asking Claude (he can review, not lead)

---

## Appendix: Cheat Sheet for Phase 8+ Development

**If you're adding a new feature:**

1. **Does it need workspace state?** → Add to AppState
2. **Does it read files?** → Use Rust (filesystem access)
3. **Does it need the editor?** → Call Tauri command from frontend
4. **Does it need LSP?** → Check language detection in `languages.js` first
5. **Does it need configuration?** → Add to `Config` struct + `~/.anvil/config.json`
6. **Does it need snapshots?** → Call `history::snapshot_before_write()` before mutation
7. **Does it emit IPC events?** → Frontend should listen via `window.__TAURI__.event.listen()`
8. **Does it spawn a child process?** → Document the lifecycle and error handling
9. **Does it need git?** → Shell out to system `git` (patterns in `git.rs`)
10. **Does it need the terminal?** → Reuse `TerminalState` (patterns in `terminal.rs`)

**Common patterns to copy:**
- File operations: See `fileOps.js` (frontend) + `main.rs:read_text_file` (Rust)
- Config access: See `provider.rs` (how it loads and validates)
- Error messages: See any command's Result type (context + reason)
- Async commands: See `agent_run` (how to structure async with State)
- LSP integration: See `lspClient.js` (how to call LSP, handle responses)
- Watcher events: See `fileOps.js` (how to listen and respond)
