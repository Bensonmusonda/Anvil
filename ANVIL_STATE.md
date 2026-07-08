# ANVIL_STATE.md

Living snapshot of the whole project, kept short and current on purpose. Paste this whole file into any new session (fresh Claude chat, or a fallback model) as the fastest way to give it the "big picture" without pasting the entire codebase. Update it whenever the file map changes — a stale map is worse than no map.

**Do not treat this as a replacement for `ANVIL_PROJECT_TRACKER.md`** — the tracker is the full phase history and decision log; this is just "what exists and what does it do," for orientation.

---

## What Anvil is, in one paragraph

An AI-native code editor: Tauri v2 (webview shell) + CodeMirror 6 (editor surface) + a Rust host process. Built incrementally, phase by phase, each with verified exit criteria. Single-process architecture (Rust daemon logic folded into the Tauri host in Phase 3).

## Current status

Phases 0 through 6.5 complete (skeleton → backend routing → editor surface → AI-in-editor with snapshot/revert/commit → agent tool-calling with MCP → LSP → polish → frontend modularization). Phase 7 (File/Folder CRUD) in progress — creation is done (commands, tree UI, empty-state welcome panel, recent workspaces, no-workspace creation fallback); delete and rename haven't been started. 4/14 Phase 7 checklist items complete. Full detail, exit criteria, and decisions: `ANVIL_PROJECT_TRACKER.md`.

**Active task right now:** _Phase 7 continuing — `delete_path`/`rename_path` commands + UI next, plus making the tree refresh on external watcher events generally (not just after Anvil's own CRUD operations)._

---

## File map

### `src/` — frontend (Tauri webview, vanilla JS ES modules, no bundler)

| File | Responsibility |
|---|---|
| `main.js` | Composition root only — gathers extensions from other modules, constructs the editor via `createEditor()`, calls every module's `init*Bindings()`. ~45 lines, no logic of its own. |
| `state.js` | Shared mutable app state (`appState.currentWorkspacePath`, `currentFilePath`, `suppressNextReload`) + `showStatus()`. Zero dependencies — bottom of the module graph. |
| `editorSetup.js` | Owns the CodeMirror `EditorView` instance. Exports `createEditor(extensions)` as a factory (not constructed at module load) specifically to avoid a circular-dependency risk with LSP/AI extensions. Also: theme, per-file language mapping, `setEditorContent()`. |
| `lspClient.js` | All LSP protocol logic: position conversion, `rustCompletionSource`, `rustHover`, `goToDefinition` (+ `definitionKeymap`), didOpen/didChange/didClose lifecycle, diagnostics listener. Has an intentional (safe) circular import with `fileOps.js` — see the comment at the top of this file before "fixing" it. |
| `fileOps.js` | `openFile`, `saveFile`, `revertFile`, `commitFile` + the external file-change watcher listener. Single source of truth for file save/revert/commit — used by the toolbar buttons and the command palette both. Calls `emptyState.js`'s `updateEmptyState()` after a file opens. |
| `fileTree.js` | Sidebar tree: lazy directory loading, workspace opening, native folder/file picker dialogs, right-click context menu + inline file/folder creation, recent-workspaces rendering. Single `activeSelection` concept drives create-target for both right-click and left-click (a selected folder targets itself, a selected file targets its parent dir). No-workspace creation fallback (native save dialog for files, folder-picker + themed prompt for folders) auto-opens the result as the workspace, since Save/Revert/Commit all require `workspace_root`. |
| `emptyState.js` | `updateEmptyState()` — toggles the welcome overlay shown whenever no file is open, workspace open or not. Deliberately a leaf module (only imports `state.js`) so both `fileTree.js` and `fileOps.js` can call it without creating a new circular import between them. |
| `promptDialog.js` | `showPromptDialog()` — themed modal replacement for `window.prompt()`, used where there's no tree row to attach an inline input to (currently just naming a folder before any workspace exists). Generic, not folder-specific. |
| `terminalPanel.js` | xterm.js frontend wired to the portable-pty backed terminal commands. |
| `gitPanel.js` | Git status list, stage/unstage, commit, and diff viewing (reuses the main editor pane for diffs — a deliberate shortcut, see the comment in this file). |
| `agentPanel.js` | Runs the agent tool-calling loop (`agent_run`) and displays its output. |
| `aiPanel.js` | Single-shot AI: the inline popup (Mod-k) that inserts a response at the cursor. |
| `commandPalette.js` | Ctrl/Cmd+P (fuzzy file search) and Ctrl/Cmd+Shift+P (commands). Most "connected" module — dispatches into most of the others. |
| `uiChrome.js` | Custom titlebar dropdowns, window minimize/maximize/close/drag, sidebar tab switching (single consolidated handler — a previous version split this across two separately-registered listeners that raced on the same click; see Gotchas Log), agent-pane show/hide. Exports `showExplorerPanel()` so other modules (currently `fileTree.js`) can force the Explorer tab open before showing UI inside it. |
| `languages.js` | Language detection, file extension → language mapping. Supports (Rust, Python, Go) as template; used by LSP startup and completion handlers. |
| `vendor/codemirror.bundle.js` | Locally-built CodeMirror bundle (esbuild) — never fetched from a CDN at runtime. Rebuild via the `entry.js` pattern documented in the toolkit, not by hand-editing this file. |
| `vendor/xterm.js`, `vendor/xterm-addon-fit.js` | Same local-vendoring pattern, for the terminal. |

### `src-tauri/src/` — Rust host (single process)

| File | Responsibility |
|---|---|
| `main.rs` | Tauri command registrations, `AppState` definition, filesystem/watcher/save-revert-commit commands, plus Phase 7's `create_file`/`create_folder` (both return the created path as `String`) and `get_recent_workspaces`/`add_recent_workspace` (persisted to `~/.anvil/recent_workspaces.json`, same directory/philosophy as `config.json`). |
| `config.rs` | Loads `~/.anvil/config.json` (providers, routing, mcp_servers, extensions, plus UI prefs: `auto_save`, `theme`). Cached after first load — editing the file needs an app restart. |
| `provider.rs` | OpenAI-compatible completion calls (used by `ai_complete`). |
| `agent.rs` | Tool-calling loop: sends `tools` array, dispatches `tool_calls` to native or MCP origin, loops until a final text answer or `MAX_ITERATIONS`. |
| `tool_registry.rs` | `ToolDefinition` shape + `to_openai_tool()` — the one place native/MCP tools become a uniform schema. |
| `tools_native.rs` | `read_file`, `write_file` (the latter reuses `history.rs`'s snapshot mechanism). |
| `mcp_host.rs` | Connects to one configured MCP server (fresh connection per call, not persisted) via the `rmcp` crate. Confirmed working against `@modelcontextprotocol/server-everything`. |
| `history.rs` | Snapshot/revert/commit — the `.anvil/history/` mechanism, "file on disk is truth." `snapshot_before_write` is a no-op if the target doesn't already exist, which is why Phase 7's file/folder creation didn't need to touch this file at all. Phase 7's still-pending `rename_path` will need to touch it, though — it needs to relocate a file's snapshot to match its new name. |
| `lsp.rs` | Spawns `rust-analyzer`, hand-rolled Content-Length JSON-RPC framing, relays requests/notifications. `request()` unwraps the JSON-RPC envelope before returning to the frontend — this was a real, once-broken behavior (see Gotchas Log). |
| `git.rs` | Shells out to system `git` for status/diff/stage/unstage/commit. |
| `fuzzy.rs` | `ignore` (gitignore-aware walking) + `nucleo` (fuzzy matching) for the command palette's file search. |
| `terminal.rs` | `portable-pty` backend for the integrated terminal. |
| `language.rs` | (Future; not yet implemented) Language registry for multi-language support. Design doc at `docs/LANGUAGE_REGISTRY_REFACTOR.md`. |

### `daemon/` — standalone CLI crate (NOT wired into the running app)

| File | Responsibility |
|---|---|
| `config.rs`, `main.rs`, `provider.rs` | Pure CLI provider-routing prototype from Phase 1. Kept only for isolated testing of provider config against DeepSeek/Ollama/OpenRouter without launching the full app. Has its own `anvil.config.json` — **not the same file** as `~/.anvil/config.json` used by the real app. This distinction has caused real confusion once already (see Gotchas Log). |

### `docs/` — design docs and planning

| File | Responsibility |
|---|---|
| `LANGUAGE_REGISTRY_REFACTOR.md` | Phase 5.5 design doc: abstract LSP into a language-agnostic registry to enable multi-language support without code duplication. Full code examples, testing checklist, future extensions. Not yet implemented. |

---

## Files worth reading in full before touching them

- `ANVIL_PROJECT_TRACKER.md` — full phase history, decisions, gotchas, session log
- `ANVIL_STATE.md` (this file) — project snapshot for context in new sessions
- `docs/LANGUAGE_REGISTRY_REFACTOR.md` — if working on multi-language or architecture
