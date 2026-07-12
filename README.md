# Anvil Editor

**Pre-Release Notice:** Anvil has not reached a stable release yet. This project is in early active development. Below you'll find documentation on the current state, architecture, and setup instructions for anyone interested in following along or contributing.

An AI-native code editor built for simplicity, low overhead, and extensibility.

**Built with:** Tauri v2, CodeMirror 6, Rust

---

## What is Anvil?

Anvil is a lightweight code editor designed around a simple premise: remove the friction that comes with bloated configurations, heavy dependencies, and rigid layouts. AI assistance isn't bolted on as an afterthought—it's part of the core design from the start.

The project exists because writing code should feel fast and responsive. Your tools shouldn't get in the way. It's built entirely for the love of the craft.

The approach is deliberate and incremental. Each phase of development produces something that actually works and can be tested independently before moving forward. No vaporware, no half-finished features.

### Core Design Goals

- **Provider-agnostic AI integration** — Route AI requests to local models (Ollama) or hosted services (DeepSeek, OpenRouter) through a unified interface.
- **Native performance** — Built with Tauri and Rust for speed and efficiency.
- **Extensibility without over-engineering** — Internal tools are modular from day one. Third-party extensions can come later, once the foundation is proven.

---

## Development Phases

The project moves through discrete, well-defined phases. Each one must achieve its goals before the next begins.

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Skeleton—Tauri shell, CodeMirror instance, IPC round trip | Complete |
| 1 | Backend routing prototype—Ollama, DeepSeek, OpenRouter support | In Progress |
| 2 | Text surface—File tree, syntax highlighting | Planned |
| 3 | Live AI integration—Dual-process wiring in the editor | Planned |
| 4 | Tool registry and MCP host | Planned |
| 5 | Language server integration—Autocomplete, diagnostics, navigation | Planned |
| 6 | Polish—Terminal, git integration, fuzzy finder, theming | Planned |

---

## How It Works

Anvil runs as a two-part system: a frontend shell and a backend daemon.

### Frontend Shell
A Tauri v2 webview that renders the editor surface using CodeMirror 6. It handles rendering and captures user input, but doesn't contain any business logic. Everything gets forwarded to the daemon.

### Backend Daemon
A Rust process that owns the real work: configuration, AI provider routing, filesystem operations, and (later) the tool registry and language server integration. This is the single source of truth for everything.

### State and Files
Anvil treats the filesystem as the source of truth. When you edit, the changes write directly to disk. A watcher notices the change and tells the frontend to reload. There's no complex in-memory state model—what's on disk is what's real. If you want to undo, there's a lightweight snapshot cache that lets you revert instantly.

### Extensibility
The design splits extensibility into two parts that people often mix up:

- **Internal extensibility** — New features get added through a tool registry with a consistent schema. These can be built-in or bridged through MCP (Model Context Protocol).
- **Third-party extensions** — This comes later, after the core is solid. The plan is for extensions to simply be MCP servers, so there's no need to learn a separate plugin system.

---

## Getting Started

### Prerequisites

Install Rust using [rustup](https://rustup.rs), not your system package manager. Anvil's dependencies need a current toolchain.

Then install the Tauri CLI:

```bash
cargo install tauri-cli --version "^2.0.0"
```

If you're on Linux, you'll also need the system webview libraries:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

macOS and Windows don't need anything extra—they use the system's native webview.

### Running the Editor

```bash
git clone https://github.com/Bensonmusonda/Anvil.git
cd Anvil
cargo tauri dev
```

A window should open with "Anvil Editor" in the title bar, showing a working editor with syntax highlighting.

### Testing the Phase 1 Backend

The Phase 1 daemon can be tested standalone, without the UI.

First, set up your config:

```bash
cd daemon
cp anvil.config.example.json anvil.config.json
export DEEPSEEK_API_KEY="your-key-here"
export OPENROUTER_API_KEY="your-key-here"
```

(If you're using local Ollama, you don't need to set API keys—it assumes Ollama is running on the default port.)

Build it:

```bash
cargo build --release
```

Try a single request:

```bash
./target/release/anvil-daemon --config anvil.config.json --purpose chat "Say hello in one sentence."
```

Or run it in interactive mode:

```bash
./target/release/anvil-daemon --config anvil.config.json --purpose chat
```

Type messages and press Enter to get responses. Type `exit` to quit.

---

## Project Layout

```
Anvil/
├── src/                       # Frontend (Tauri webview)
│   ├── index.html
│   ├── main.js
│   ├── style.css
│   └── vendor/                # Locally bundled JavaScript
├── src-tauri/                 # Rust backend (Tauri)
│   ├── src/main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── daemon/                    # Phase 1 standalone backend
│   ├── src/
│   ├── Cargo.toml
│   └── anvil.config.example.json
└── README.md
```

### About the Vendored Frontend Dependencies

CodeMirror 6 and related packages are bundled locally as pre-built JavaScript instead of fetched from a CDN. This keeps things simple: no runtime network calls, no CDN dependency, and builds are reproducible.

If you need to rebuild the bundle:

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

## Philosophy

Rather than reinvent the wheel for every component, Anvil uses established, well-maintained open-source projects where they make sense. CodeMirror for syntax highlighting, language servers for intelligence, proven terminal emulators for terminal support. This keeps the focus on what makes Anvil different: a clean, AI-first design without unnecessary complexity.

---

## Contributing

Contributions and feedback are welcome. Before diving in, take a look at which phase you're working toward—some features are intentionally deferred to keep the build order clean and focused.

---

## License

MIT License. See [LICENSE](LICENSE) for the full text. Use it however you like—personally, commercially, whatever. Just keep the license with it.

---

## Author

Built by [Benson Musonda](https://github.com/Bensonmusonda).

For more details on the Phase 1 backend implementation, see [daemon/README.md](daemon/README.md).
