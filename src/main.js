// Anvil Editor — Phase 0 frontend
//
// CodeMirror 6 is vendored locally (src/vendor/codemirror.bundle.js) rather
// than loaded from a CDN at runtime. This removes a runtime network
// dependency entirely — consistent with Anvil's low-overhead philosophy,
// and it's the same "vendor the JS locally" pattern already proven out in
// AirNode. It also means Phase 0 has zero points of silent failure from
// CORS/proxy/webview quirks fetching an external module.

import { EditorView, basicSetup, javascript, oneDark } from "./vendor/codemirror.bundle.js";

const startDoc = `// Anvil Editor — Phase 0
// This is a real, live CodeMirror 6 instance running inside a Tauri v2 webview.
//
// Edit this text, then hit "Send to Daemon" below. That button sends this
// exact buffer content across the process boundary to the Rust daemon,
// which echoes it back. If you see it come back, the client<->daemon
// round trip is proven — which is the entire point of Phase 0.

function helloAnvil() {
  return "no editor logic beyond this file is expected to exist yet";
}
`;

function showFatalError(context, err) {
  // Surface failures visibly instead of a silent blank editor — if this
  // ever breaks again, you'll see why, not just an empty window.
  const el = document.getElementById("editor");
  el.innerHTML = `<div style="padding:16px;color:#ff8a80;font-family:monospace;font-size:13px;white-space:pre-wrap;">
FAILED TO INITIALIZE EDITOR
Context: ${context}
Error: ${err && err.message ? err.message : String(err)}
</div>`;
}

let editor;
try {
  editor = new EditorView({
    doc: startDoc,
    extensions: [basicSetup, javascript(), oneDark],
    parent: document.getElementById("editor"),
  });
} catch (err) {
  showFatalError("mounting CodeMirror", err);
}

const resultEl = document.getElementById("result");

document.getElementById("ping-btn").addEventListener("click", async () => {
  if (!editor) {
    resultEl.textContent = "Editor failed to initialize — see error above. Cannot send.";
    return;
  }

  const message = editor.state.doc.toString();
  resultEl.textContent = "sending to daemon...";

  try {
    if (!window.__TAURI__ || !window.__TAURI__.core) {
      throw new Error("window.__TAURI__.core is not available — check withGlobalTauri in tauri.conf.json");
    }
    const response = await window.__TAURI__.core.invoke("ping", { message });
    resultEl.textContent = response;
  } catch (err) {
    resultEl.textContent = "Error calling daemon: " + (err && err.message ? err.message : String(err));
  }
});

// Catch anything that slips past the above (e.g. an error during the
// dynamic import itself) so failures are never silent.
window.addEventListener("error", (event) => {
  if (!editor) {
    showFatalError("script error", event.error || event.message);
  }
});