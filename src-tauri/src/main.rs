// Anvil Editor — Phase 0: Skeleton
//
// Purpose: prove the client<->daemon round trip works before any real
// editor logic exists. This file intentionally contains no filesystem,
// provider-routing, or tool-registry logic — that belongs to later phases.

/// A trivial IPC round-trip command. The frontend sends a string; the
/// daemon echoes it back with a marker proving the message actually
/// crossed the process boundary and returned, rather than being faked
/// client-side.
#[tauri::command]
fn ping(message: String) -> String {
    format!(
        "[daemon] received {} bytes — round trip confirmed: \"{}\"",
        message.len(),
        message
    )
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running Anvil daemon");
}
