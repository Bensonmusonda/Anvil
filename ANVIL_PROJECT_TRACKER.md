# Anvil Editor — Project Tracker

A living companion to `Anvil_Editor_Specification_v2.docx`. Update this file as you work — it's meant to get messy and current, not stay polished. The spec is the "what and why"; this is the "where are we now."

---

## 1. Phase Checklist

Check items off as they're _verifiably_ done (exit criteria met), not just started.

### Phase 0 — Skeleton

- [x] `create-tauri-app` scaffold running
- [x] Blank CodeMirror 6 instance rendering in the webview
- [x] One round-trip IPC message (frontend → Rust → frontend)

### Phase 1 — Backend Routing Prototype

- [x] Config parser reads and validates the provider/routing schema
- [x] Ollama proxy bridge working
- [x] DeepSeek proxy bridge working
- [ ] OpenRouter proxy bridge working
- [x] stdin/stdout agent script loop operational
- [x] `curl`/CLI test returns real completions from ≥2 providers

### Phase 2 — Text Surface Assembly

- [x] Tauri UI workspace shell built
- [x] CodeMirror instance wired to filesystem reads
- [x] File tree navigation working
- [x] Syntax highlighting via `@codemirror/lang-*` for target languages
- [x] Can open and browse a real project directory

### Phase 3 — Dual-Process Wiring

- [x] Client↔daemon communication loop bound
- [x] AI generation output reaches the editor view
- [x] Filesystem watcher (`notify`) firing IPC invalidation signals
- [x] `.anvil/history/` snapshot-on-mutation working
- [x] Revert-to-snapshot working
- [x] Commit (clear history) working

### Phase 4 — Tool Registry + MCP Host

- [x] `read_file` tool implemented natively
- [x] `write_file` tool implemented natively
- [x] Tool Registry Service exposing declarative JSON schemas
- [x] MCP Host built on official MCP SDK
- [x] ≥1 real external MCP server connected and callable
- [x] Agent completes a task mixing a built-in tool + an MCP tool

### Phase 5 — LSP Integration

- [x] Daemon can spawn a language server per project language
- [x] LSP JSON-RPC proxied to frontend
- [x] Autocomplete via LSP working
- [x] Go-to-definition / references working
- [x] Inline diagnostics working
- [x] Hover documentation working

### Phase 6 — Polish

- [x] Integrated terminal (`portable-pty` + `xterm.js`)
- [x] Git panel (status/stage/commit/diff)
- [x] Fuzzy file/command finder (`nucleo`)
- [x] Theming (config-driven, no rebuild)
- [x] Used as daily driver on one real project

### Phase 6.5 — Frontend Modularization
- [x] Split main.js into 12 focused ES modules
- [x] main.js reduced to composition root only
- [x] Verified: no broken imports, no missing DOM references
- [x] Fixed 2 latent bugs found during split (saveFile, loadFile → openFile)

### Phase 7 — File/Folder CRUD
- [x] `create_file` command (creates empty file at given path)
- [x] `create_folder` command
- [x] `delete_path` command — uses the `trash` crate (system trash), NOT permanent deletion by default
- [x] Separate `delete_path_permanent` command (or a flag) for the Edit-menu permanent-delete option
- [x] `rename_path` command — also relocates any corresponding `.anvil/history/` snapshot to the new name
- [x] Right-click context menu on tree rows (files and folders both)
- [x] New File / New Folder — creates inside the clicked folder, or at workspace root if triggered on empty tree space
- [x] Rename — inline edit or prompt, updates tree without a full reload
- [x] Delete (trash) — confirmation before executing
- [x] Permanent delete — accessible via Edit dropdown AND Ctrl+Shift+Delete shortcut, with a more emphatic confirmation than regular delete
- [x] Deleting the currently-open file explicitly clears the editor/currentFilePath — not left to the watcher's reload attempt to fail
- [x] File tree refreshes on relevant watcher events generally, not just after Anvil's own CRUD operations (closes existing gap — see discussion)
- [ ] Verified: creating, renaming, and deleting (both trash and permanent) a file and a folder, confirmed on disk via terminal
- [ ] Verified: external change (e.g. `touch`/`mkdir` via terminal, outside Anvil) shows up in the tree without manually reopening the workspace

### Phase 8 — Generalized Tabs
- [ ] `Tab { id, kind, title, contentRef }` data model — `kind` supports future non-file tabs even though only `"file"` exists now
- [ ] Tab bar UI: open, close, switch between tabs
- [ ] Multiple `EditorState`s cached (one per open file) and swapped into the single `EditorView` on tab switch — not recreating the editor each time
- [ ] Opening a file from the tree/palette reuses an existing tab if already open, rather than duplicating
- [ ] Unsaved-changes indicator per tab (requires defining "unsaved" — diff against last-saved content, since there's no continuous autosave)
- [ ] Closing a tab with unsaved changes prompts before discarding
- [ ] Middle-click or close-button closes a tab without switching to it first
- [ ] Verified: open 3+ files, switch between them, confirm each retains its own scroll position/cursor/undo history, not just its text content

### Phase 9 — Resizable/collapsible panes
- [ ] Left sidebar: drag handle to resize width
- [ ] Right agent sidebar: drag handle to resize width
- [ ] Both panes respect a sensible min/max width (don't allow dragging to zero or absurdly wide)
- [ ] Collapse behavior (already exists for both panes via toggle buttons) still works after adding resize — confirm one doesn't break the other
- [ ] Pane width persisted across restarts (likely a config.rs addition, alongside the existing `theme`/`auto_save` prefs)
- [ ] Verified: resize both panes, restart the app, confirm widths are remembered

---

## 2. Locked Decisions

Record decisions once made so they don't get silently re-litigated later.

| Date       | Decision                                                                                                     | Rationale                                                                                                                   | Status                |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------- |
|            | Daemon language: Rust vs Go                                                                                  |                                                                                                                             | ⬜ Open                |
|            | v1 extension format = MCP servers only                                                                       | Avoids designing a second plugin format before one is needed                                                                | ✅ Proposed in spec §8 |
|            | Telemetry/crash reporting: none / opt-in                                                                     |                                                                                                                             | ⬜ Open                |
| 2026-07-05 | fold daemon into src-tauri instead of separate OS process                                                    |                                                                                                                             |                       |
| 2026-07-05 | Used `gpt-oss:20b-cloud`for the phase 4 tests                                                                | Excels at tool calling                                                                                                      |                       |
| 2026-07-06 | LSP transport: hand-rolled Content-Length JSON-RPC framing (no wrapper crate)                                | Protocol is small, stable, well-documented — not worth a dependency for it                                                  | ✅ Locked              |
| 2026-07-06 | Phase 5 supports rust-analyzer only; other languages deferred                                                | Matches incremental, one-thing-verified-at-a-time approach used every phase so far                                          | ✅ Locked              |
| 2026-07-06 | lsp_request unwraps the JSON-RPC envelope and returns only the inner `result` to the frontend                | Original version returned the full envelope, causing hover/completion/definition to silently return empty — see Gotchas Log | ✅ Locked              |
| 2026-07-06 | Active development moved from Claude-authored file edits to Antigravity IDE, with Claude as reviewer/advisor | Context between chat and on-disk code had drifted; safer to have one tool actually touching files                           | ✅ Locked              |
| 2026-07-09 | Phase 8 tabs: LSP stays single-document — only the active tab has a live rust-analyzer session (didOpen/didClose swap on tab switch, same mechanism as today's file switch) | Full multi-document LSP sync (tracking versions/diagnostics for every open tab at once) is materially bigger than what Phase 8's checklist asks for; split out as a follow-up (see Parked Ideas) | ✅ Locked |
| 2026-07-09 | Phase 8 tabs: external file-change reload stays active-tab-only — a background tab's file changing on disk won't live-reload until you switch to it | Same reasoning as the LSP call above; keeps the tab data model's first pass scoped to what the checklist actually asks for | ✅ Locked |
| 2026-07-09 | Phase 8 tabs: rename integration (updating an open tab when its file, or an ancestor folder, gets renamed) is an explicit follow-up after the tab data model exists, not part of building it | Needs the data model to hook into first — sequencing, not scope-cutting; called out here so it doesn't get silently dropped | ✅ Locked |

---

## 3. Open Questions / Risks

Pull these from spec §11 and add new ones as they surface. Move to "Locked Decisions" once resolved.

- [ ] Rust vs. Go for the daemon — decide before Phase 1 starts
- [ ] LSP process lifecycle (spawn/restart/kill) strategy
- [ ] Frontend-contributed UI extension points — separate design effort if ever pursued
- [ ] Minimum viable local hardware spec for Ollama-based inline completion
- [ ] Telemetry/crash reporting stance

---

## 4. Dependency / Version Log

Track exact versions once chosen, so "it worked on my machine" has a paper trail.

|Component|Package/Crate|Version Pinned|Notes|
|---|---|---|---|
|App shell|Tauri|||
|Editor|CodeMirror|6.x||
|Filesystem watch|notify||Rust crate|
|Diffing|similar||Rust crate|
|Git|git2 / system git|||
|Fuzzy search|nucleo|||
|Terminal backend|portable-pty|||
|Terminal frontend|xterm.js|||
|MCP|official MCP SDK||Rust or TS|
|HTTP/streaming|reqwest + eventsource-stream|||
|Trash (Phase 7 delete)|trash|5.2.6|Rust crate|

---

## 5. Session Log

One line per work session. Keeps momentum visible and makes it easy to pick up after a break.

```
YYYY-MM-DD — What I worked on — What's next
```

- 2026-07-04 — Refined project spec (v2), added Phase 0 and Phase 5, drafted OSS adoption table — Start Phase 0 scaffold
- 2026-07-05 — Phase 3 complete: AI-in-editor, watcher, snapshot/revert/commit all verified — Start Phase 4
- 2026-07-06 — Phase 5 complete: rust-analyzer wired in (Content-Length JSON-RPC relay), all four features (autocomplete, hover, go-to-def, diagnostics) verified against a real project with external deps (clap, anyhow). Root cause of the hover/completion/definition bug found by Antigravity (JSON-RPC envelope not unwrapped) after Claude misdiagnosed it as a workspace-loading issue. Switched active development to Antigravity IDE going forward; Claude's role shifts to review/advisory to avoid drift between chat context and on-disk code. — Next: scope Phase 6 (Polish)
- 2026-07-08 — Phase 7 continued and closed out (code-complete): `rename_path` (with `.anvil/history/` snapshot relocation, and extended mid-session to support cross-directory moves, not just same-folder renames), `delete_path` (trash crate) and `delete_path_permanent` (with best-effort snapshot cleanup for the single-file case), inline rename UI with prefix-remapping for `currentFilePath`/`expandedPaths` when an ancestor folder is renamed, delete confirmations (plain + stronger permanent-delete), right-click context menu additions, new Edit dropdown, F2/Ctrl+Alt+N/Ctrl+Alt+Shift+N/Delete/Ctrl+Shift+Delete shortcuts, "Open File…" added to the File dropdown (was missing), and watcher-triggered tree refresh (debounced, skipped while an inline create/rename input is open). Found and fixed a real race: deleting the currently-open file could trigger `fileOps.js`'s `file-changed` reload attempt before `handleDeletedPath()` cleared `currentFilePath`, since the watcher event and the delete command's own promise resolve independently — fixed with `appState.suppressNextReload`, same guard `saveFile()`/`revertFile()` already used. — Next: manual verification (on-disk confirmation of create/rename/delete, live external-change test), then start Phase 8 (Generalized Tabs)

---

## 6. Parked Ideas (Not in Spec)

Ideas worth remembering but deliberately not committed to yet — revisit when the trigger condition is met, don't build toward them before then.

| Idea                                                                   | Why not now                                                                                                                                                                                        | Revisit when                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fine-tune a model on Anvil's architecture + extension-writing patterns | Architecture is still pre-Phase-0 and will shift; no real corpus of correct extensions exists yet to train on; adds a training/eval/hosting pipeline that cuts against the low-overhead philosophy | A dozen+ real, working extensions exist and the tool-registry/API surface has settled. Until then, get the same benefit cheaply via context-priming (spec + example extensions fed to a general-purpose model in an "extension-authoring mode") rather than a training run. |
| Multi-document LSP sync — track didOpen/didChange/diagnostics for every open tab simultaneously, not just the active one | Phase 8's checklist doesn't call for it, and it's a materially bigger change than the tab data model itself (see Locked Decisions, 2026-07-09) | Once Phase 8's tabs are built and stable, if background-tab diagnostics/completions turn out to be a felt need in practice |
| Background-tab live-reload on external file change | Deferred alongside multi-document LSP sync, for the same reason and on the same trigger | Same as the row above |
| Language Registry refactor — abstract LSP init behind a `LanguageServer` trait + registry (`language.rs` backend, `languages.js` frontend) so a second language (Python/Go/etc.) doesn't mean duplicating `lsp.rs`/`lspClient.js`'s Rust-specific logic. Full design doc supplied 2026-07-09, not yet implemented. | Only one language (Rust) is actually in use today; building the abstraction now is generalizing ahead of a second real language actually existing | A second language's LSP support is genuinely being added — the design doc is ready to go at that point, this row is just the pointer to it |

---
## 7. Git Workflow

One short-lived branch per phase (or sub-task within a phase). `main` always stays in a working state.

**Per phase:**
```bash
git checkout -b phase-N-name
# commit as you go
git add .
git commit -m "..."
```

**When exit criteria are actually met (not just "seems done"):**
```bash
git checkout main
git merge phase-N-name
git tag phase-N-complete
git branch -d phase-N-name
```

**Habit:** commit *before* starting a hard bug fix, not after — gives a clean diff and an escape hatch (`git checkout .`) if the fix makes things worse.

**Push:**
```bash
git push -u origin main --tags
```

---
## 8. Gotchas Log

Non-obvious, environment-specific lessons worth remembering — the kind of thing that looks like a new bug but isn't.

| Date       | Symptom                                                                                                                    | Root Cause                                                                                                                                                                                                         | Fix                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-05 | External file edits didn't trigger a reload in the editor                                                                  | `notify` watcher only matched `Modify`/`Create`/`Remove` events — editors that save atomically (write temp file, rename over original) can emit events that don't cleanly match that filter                        | Broadened the watcher's event filter to accept everything except pure `Access` events                                                                                       |
| 2026-07-05 | `window.__TAURI__.event.listen` threw "not allowed" despite `withGlobalTauri: true`                                        | Tauri v2's capability/permission system gates its own `core:event` API — this is separate from custom `#[tauri::command]`s, which are *not* capability-gated                                                       | Added `src-tauri/capabilities/default.json` granting `core:event:default` / `core:event:allow-listen`                                                                       |
| 2026-07-05 | Model narrates instead of calling                                                                                          | Looks like a code bug but is actually a model-capability tell, and easy to misdiagnose next time a different local model gets tried.                                                                               | Switched from a local `llama3.2-local:latest` model to a cloud `gpt-oss:20b-cloud` on Ollama                                                                                |
| 2026-07-06 | `rust-analyzer` reported "Unknown binary" despite `which rust-analyzer` finding something                                  | rustup installs a proxy binary on PATH regardless of whether the actual component is installed — `which` confirms existence, not that it works                                                                     | `rustup component add rust-analyzer`                                                                                                                                        |
| 2026-07-06 | rust-analyzer logged `ERROR duplicate DidOpenTextDocument`                                                                 | Re-opening an already-open file resent `didOpen` without a `didClose` first — a real LSP protocol violation                                                                                                        | Track currently-open path; send `didClose` before switching files, skip re-sending `didOpen` for the same file                                                              |
| 2026-07-06 | Only one LSP message (`workspace/diagnostic/refresh`) ever appeared in logs; no indexing progress                          | That message is a server-initiated *request* (has an `id`), not a notification — our relay only replied to responses to requests *we* sent, never acknowledged server-initiated ones, so a strict server may stall | Acknowledge any message with an unrecognized `id` + a `method` field with a null-result response                                                                            |
| 2026-07-06 | Hover/completion/definition all silently returned empty even on a fully-loaded workspace (confirmed via raw devtools test) | `lsp_request` returned the full JSON-RPC envelope (`{jsonrpc, id, result}`), but every frontend handler read fields as if `result` were the top level                                                              | Unwrap `result` before returning from `lsp_request` (found and fixed by Antigravity, not Claude)                                                                            |
| 2026-07-06 | Autocomplete showed real but oddly-ordered/unranked suggestions                                                            | CodeMirror's own fuzzy matcher was re-scoring completions, discarding rust-analyzer's `sortText` relevance ordering; all items also showed as generic type due to unmapped LSP `kind`                              | Sort by `sortText` before returning to CM6, apply descending `boost`, map LSP `kind` codes to CM6 completion types                                                          |
| 2026-07-07 | Two command palette actions would have thrown ReferenceError if triggered                                                  | Antigravity-era code referenced `saveFile()`/`loadFile()` that were never actually defined anywhere                                                                                                                | Found via systematic review during the Phase 6.5 module split — worth periodically grepping for called-but-undefined functions, not just relying on it surfacing at runtime |
| 2026-07-08 | §1 showed every Phase 7 item unchecked at the start of the delete/rename session, despite creation work (from an earlier, rate-limited session) already done and working on disk | The earlier session hit a rate limit before its tracker update ever got made — `ANVIL_STATE.md` and the actual code were both ahead of what §1 recorded | Cross-checked `ANVIL_STATE.md` + the actual uploaded files against §1 before trusting the checklist; worth doing that cross-check whenever picking up a phase that a previous session "started but didn't finish" |
| 2026-07-08 | Deleting the currently-open file sometimes showed "File changed but couldn't reload: not a file: ..." instead of clearing the editor cleanly | `delete_path`/`delete_path_permanent`'s own promise and the `notify` watcher's `file-changed` event resolve independently — the watcher event could reach `fileOps.js`'s reload listener before the delete command's own success handler had cleared `appState.currentFilePath` | Set `appState.suppressNextReload = true` immediately before the delete invoke, same guard `saveFile()`/`revertFile()` already used for the identical race |


---
## 9. Milestone Targets

Fill in once you have a rough calendar in mind — these are placeholders.

| Milestone                    | Target Date | Actual Date |
| ---------------------------- | ----------- | ----------- |
| Phase 0 complete             |             |             |
| Phase 1 complete             |             |             |
| Phase 2 complete             |             |             |
| Phase 3 complete             |             |             |
| Phase 4 complete             |             |             |
| Phase 5 complete             |             |             |
| Phase 6 / daily-driver ready |             |             |