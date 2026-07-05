# Anvil Daemon — Phase 1: Backend Routing Prototype

Standalone Rust binary, no UI dependency — exactly per the Phase 1 exit criteria. This can be built and run entirely on its own before any Tauri/frontend work is touched.

## Verification status (read before running)

✅ **Verified:** JSON schema validity, and structural sanity (brace/paren balance) of every Rust file.

❌ **Not verified here:** an actual `cargo build`. This was written in the same sandbox that couldn't fully build the Phase 0 Tauri app either — its `apt`-installed Rust (1.75) is now too old for current crates.io releases across the board, not just Tauri's. Every dependency tree I tried (`reqwest` 0.12, then 0.11, with either `rustls-tls` or `native-tls`) hit the same wall a layer deeper each time, so I stopped chasing it rather than keep pinning versions indefinitely.

**Why I'm still confident:** your machine already compiled something far heavier than this — the full Tauri + `webkit2gtk` + `tao` + `muda` stack — cleanly with `rustup`'s current toolchain. This daemon's dependency tree (`reqwest`, `tokio`, `serde`, `anyhow`) is considerably lighter. It should build without the issues seen here.

## Building

```bash
cd daemon
cargo build --release
```

## Running

1. Copy the example config and fill in real values:
   ```bash
   cp anvil.config.example.json anvil.config.json
   export DEEPSEEK_API_KEY="your-key-here"
   export OPENROUTER_API_KEY="your-key-here"
   ```
   (`local_ollama` needs no key — it assumes Ollama is running locally on the default port.)

2. **Single-shot mode** (good for quick tests):
   ```bash
   ./target/release/anvil-daemon --config anvil.config.json --purpose chat "Say hello in one sentence."
   ```

3. **Interactive stdin/stdout mode** (the "agent script loop" from the spec):
   ```bash
   ./target/release/anvil-daemon --config anvil.config.json --purpose chat
   ```
   Type messages, press Enter, get completions back. Type `exit` to quit.

## Confirming the Phase 1 exit criterion

Run the single-shot command above against **at least two different providers** — e.g. once with `--purpose chat` (routed to DeepSeek in the example config) and once after temporarily pointing `routing.inline` at `local_ollama` with Ollama running locally. If both return real completion text, the exit criterion — *"a CLI test returns real completions from at least two configured providers"* — is met. Check it off in the tracker.

## If the build fails

Please paste the exact `cargo build` error back — given the gap between the sandbox and your real toolchain, I'd rather fix a real error than guess at one that might not even occur.

## What's deliberately NOT in this phase

- No Tauri/UI integration (Phase 3)
- No streaming responses (adds `eventsource-stream`, deferred until the chat panel needs it in Phase 3)
- No tool calling / MCP (Phase 4)
- No config hot-reload — restart the binary after editing `anvil.config.json`
