# Anvil Editor

> **⚠️ Pre-Release Notice:** Anvil has not yet reached a stable release. This project is in active early development. Progress tracking and setup instructions are available below for developers and contributors interested in following along.

An AI-native code editor built for low overhead and real extensibility.

**Built with:** Tauri v2 · CodeMirror 6 · Rust Daemon

---

## Overview

Anvil is an independent, lightweight code editor designed to eliminate the configuration friction, dependency bloat, and layout constraints common in mainstream editors. AI assistance and extensibility are treated as first-class design concerns from inception, not afterthoughts.

Anvil is **not** positioned as a day-one drop-in replacement for VS Code. It's being built incrementally: each development phase must produce something independently testable and functional before the next phase begins.

### Core Design Principles

- **Provider-agnostic AI** — Route AI requests across local models (Ollama) and hosted providers (DeepSeek, OpenRouter) through a single OpenAI-compatible interface.
- **Low overhead** — Native compilation (Tauri + Rust) instead of heavyweight Electron-style runtimes.
- **Real extensibility without premature complexity** — Internal tooling is modular from day one. Third-party extension support is deliberately deferred until the architecture has proven itself.

---

## Development Status

Anvil is organized into discrete, sequential development phases. Each phase must achieve its exit criteria before the next begins.

| Phase | Description | Status |
|-------|-------------|--------|
| **0** | **Skeleton** — Tauri shell, CodeMirror instance, IPC round trip | ✅ Complete |
| **1** | **Backend routing prototype** — Ollama / DeepSeek / OpenRouter integration | 🔜 In Progress |
| **2** | **Text surface** — File tree, syntax highlighting, basic navigation | Planned |
| **3** | **Dual-process wiring** — Live AI generation in the editor | Planned |
| **4** | **Tool Registry + MCP Host** — Model Context Protocol support | Planned |
| **5** | **LSP integration** — Autocomplete, diagnostics, go-to-def | Planned |
| **6** | **Polish** — Terminal, git panel, fuzzy finder, theming | Planned |

---

## Architecture

Anvil operates as a **dual-process application**:

### Frontend Shell
A Tauri v2 webview rendering a CodeMirror 6 editing surface. The frontend holds no business logic; it renders state and forwards user intent to the daemon.

### Core Daemon
A native Rust process that owns:
- Configuration and settings
- AI provider routing and orchestration
- Filesystem access and monitoring
- (Later) Tool registry and MCP host

The daemon is the **single source of truth** for all state and behavior.

### State Model
Anvil follows a **"file on disk is truth"** philosophy:
1. Edits write immediately to disk
2. A filesystem watcher signals the frontend to reload
3. A lightweight snapshot cache enables instant revert
4. No separate in-memory state model

### Extensibility

Two distinct concerns kept intentionally separate:

- **Internal extensibility** (in progress) — New capabilities are added via a uniform Tool Registry schema, whether built-in or bridged through the Model Context Protocol (MCP).
- **Third-party extensions** (reserved) — Extensions are designed to *be* MCP servers, avoiding the need for a separate plugin format. The configuration already reserves the seam for this integration.

---

## Getting Started

### Prerequisites

- **Rust** — Install via [rustup](https://rustup.rs), **not** your OS package manager. Anvil's dependencies require a recent toolchain.
- **Tauri CLI**:
  ```bash
  cargo install tauri-cli --version "^2.0.0"
  ```
- **Linux only** — System webview dependencies:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```
  (macOS and Windows use their OS-native webview and require no additional installation.)

### Running the Editor

```bash
git clone https://github.com/Bensonmusonda/Anvil.git
cd Anvil
cargo tauri dev
```

A window titled **"Anvil Editor"** should open with a live, syntax-highlighted editing surface.

### Testing the Phase 1 Daemon

The Phase 1 backend routing prototype can be tested independently:

1. **Prepare configuration:**
   ```bash
   cd daemon
   cp anvil.config.example.json anvil.config.json
   export DEEPSEEK_API_KEY="your-key-here"
   export OPENROUTER_API_KEY="your-key-here"
   ```
   (Local Ollama requires no key — it assumes Ollama is running on the default port.)

2. **Build:**
   ```bash
   cargo build --release
   ```

3. **Single-shot mode** (quick testing):
   ```bash
   ./target/release/anvil-daemon --config anvil.config.json --purpose chat "Say hello in one sentence."
   ```

4. **Interactive mode** (agent script loop):
   ```bash
   ./target/release/anvil-daemon --config anvil.config.json --purpose chat
   ```
   Type messages, press Enter to receive completions. Type `exit` to quit.

---

## Project Structure

```
Anvil/
├── src/                       # Frontend (Tauri webview)
│   ├── index.html
│   ├── main.js
│   ├── style.css
│   └── vendor/                # Locally vendored JS dependencies
├── src-tauri/                 # Rust daemon (Tauri backend)
│   ├── src/main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── daemon/                    # Phase 1 standalone daemon prototype
│   ├── src/
│   ├── Cargo.toml
│   └── anvil.config.example.json
└── README.md
```

### Frontend Dependencies

Frontend JavaScript dependencies (currently CodeMirror 6) are vendored as pre-built local bundles rather than fetched from a CDN at runtime. This approach:
- Eliminates runtime network dependencies
- Ensures reproducible builds
- Simplifies deployment

To rebuild the CodeMirror bundle:

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
cp codemirror.bundle.js <path-to-Anvil>/src/vendor/codemirror.bundle.js
```

---

## Design Philosophy

Components that are not core to Anvil's unique identity are adopted from mature, battle-tested open-source projects rather than rebuilt:

- **Syntax highlighting** — CodeMirror's own language packages
- **Language intelligence** — Language Server Protocol (LSP) providers
- **Terminal emulation** — Established terminal libraries

This approach allows the team to focus on the distinctive value Anvil provides: low-overhead, AI-first extensibility.

---

## Contributing

Contributions, feedback, and issue reports are welcome. Please review the current phase goals before proposing changes — features intended for later phases may be deliberately deferred to maintain a clean, incremental build order.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for full details.

You are free to use, modify, and distribute this code for any purpose — personal, commercial, or otherwise — provided you include the original license text.

---

## Author

Built by [Benson Musonda](https://github.com/Bensonmusonda) as part of the Bennieslab ecosystem.

---

## Additional Resources

- **Phase 1 Daemon Details** — See [daemon/README.md](daemon/README.md) for a detailed guide to the backend routing prototype.
- **Issues & Feature Requests** — Open an issue to report bugs or propose enhancements.
