<div align="center">

# Anvil Editor

**An AI-native code editor, built for low overhead and real extensibility.**

Tauri v2 · CodeMirror 6 · Rust Daemon

*Status: Phase 0 (Skeleton) complete — early development*

</div>

---

## What is Anvil?

Anvil is an independent, lightweight code editor built to remove the configuration friction, dependency bloat, and layout rigidity common in mainstream editors — while treating AI assistance and extensibility as core architecture, not bolted-on features.

It's not aiming to be a drop-in replacement for VS Code on day one. It's being built incrementally: each phase has to earn its place by actually working, before the next one starts.

**Core goals:**
- **Provider-agnostic AI** — route requests across local models (Ollama) and hosted providers (DeepSeek, OpenRouter) through a single OpenAI-compatible interface.
- **Low overhead** — native compilation (Tauri + Rust) instead of a heavy Electron-style runtime.
- **Real extensibility, without premature complexity** — internal tooling is modular from day one; third-party extension support is deliberately deferred until there's something real to design it against (see [Architecture](#architecture) below).

## Current Status

| Phase | Description | Status |
|---|---|---|
| 0 | Skeleton — Tauri shell, CodeMirror instance, IPC round trip | ✅ Complete |
| 1 | Backend routing prototype (Ollama / DeepSeek / OpenRouter) | 🔜 Next |
| 2 | Text surface assembly (file tree, syntax highlighting) | Planned |
| 3 | Dual-process wiring (live AI generation in the editor) | Planned |
| 4 | Tool Registry + MCP Host | Planned |
| 5 | LSP integration (autocomplete, diagnostics, go-to-def) | Planned |
| 6 | Polish (terminal, git panel, fuzzy finder, theming) | Planned |

## Architecture

Anvil runs as a dual-process application:

- **Frontend shell** — a Tauri v2 webview rendering a CodeMirror 6 surface. It holds no business logic; it renders state and forwards intent.
- **Core daemon** — a native Rust process that owns configuration, AI provider routing, filesystem access, and (later) the tool registry and MCP host. The daemon is the single source of truth.

State follows a **"file on disk is truth"** model: edits write straight to disk, a filesystem watcher signals the frontend to reload, and a lightweight snapshot cache enables instant revert — no in-memory virtual buffer diffing.

Extensibility is intentionally split into two concerns that are easy to conflate:
- **Internal extensibility** (in progress) — new capabilities are added via a Tool Registry with a uniform schema, regardless of whether a tool is built-in or bridged through the [Model Context Protocol](https://modelcontextprotocol.io/).
- **Third-party extensions** (reserved, not yet built) — the plan is for extensions to simply *be* MCP servers, avoiding a second plugin format. The config schema already reserves the seam for this so it won't require a breaking change later.

## Getting Started

### Prerequisites

- **Rust** (install via [rustup](https://rustup.rs), not your OS package manager — Anvil's dependencies require a recent toolchain)
- **Tauri CLI**:
  ```bash
  cargo install tauri-cli --version "^2.0.0"
  ```
- **Linux only** — system webview dependencies:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```
  macOS and Windows use their OS-native webview and need nothing extra.

### Running

```bash
git clone https://github.com/<your-username>/anvil-editor.git
cd anvil-editor
cargo tauri dev
```

A window titled **"Anvil Editor"** should open with a live, syntax-highlighted editor.

## Project Structure

```
anvil-editor/
├── src/                    # Frontend (Tauri webview)
│   ├── index.html
│   ├── main.js
│   ├── style.css
│   └── vendor/              # Locally vendored JS deps (see below)
└── src-tauri/               # Rust daemon
    ├── src/main.rs
    ├── Cargo.toml
    └── tauri.conf.json
```

### A note on `src/vendor/`

Frontend JS dependencies (currently just CodeMirror 6) are vendored as pre-built local bundles rather than fetched from a CDN at runtime — this avoids a runtime network dependency and sidesteps webview-specific CORS/module-loading quirks entirely. Vendor bundles are **not built from source in this repo yet**; regenerate them with:

```bash
mkdir -p /tmp/cm-build && cd /tmp/cm-build
npm init -y
npm install codemirror@6.0.1 @codemirror/lang-javascript@6.2.2 @codemirror/theme-one-dark@6.1.2 esbuild@0.23.1

cat > entry.js << 'EOF'
export { EditorView, basicSetup } from "codemirror";
export { javascript } from "@codemirror/lang-javascript";
export { oneDark } from "@codemirror/theme-one-dark";
EOF

./node_modules/.bin/esbuild entry.js --bundle --format=esm --outfile=codemirror.bundle.js
cp codemirror.bundle.js <path-to-anvil-editor>/src/vendor/codemirror.bundle.js
```

## Philosophy

Components that aren't core to Anvil's identity are adopted from mature open-source projects rather than rebuilt — syntax highlighting via CodeMirror's own language packages, language intelligence via real LSP servers, diffing via the `similar` crate, and so on. The test applied to any dependency: it must run as a native library or process behind the daemon, never become an independent source of truth for editor state, and never require a heavy runtime stack of its own.

## Roadmap

See the phase table above for the current build order. Each phase ships something independently testable before the next begins — no phase depends on visual polish from a later one to be verified as working.

## Author

Built by [Benson Musonda](https://github.com/Bensonmusonda) as part of the Bennieslab ecosystem.

## License