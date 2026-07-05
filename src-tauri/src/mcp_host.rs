//! MCP Host (spec §4.1). Connects to a single external MCP server over
//! stdio (spawned as a child process per call — see main.rs module comment
//! for why this is per-call rather than a persisted connection), discovers
//! its tools, and exposes/calls them through the same ToolDefinition shape
//! as native tools.
//!
//! ⚠️ CONFIDENCE NOTE — read this before debugging anything else in Phase 4:
//! rmcp is a newer, less battle-tested SDK than reqwest/notify/tauri, which
//! this project has otherwise relied on. The connect → list_all_tools →
//! call_tool flow below is grounded in real examples from the SDK's own
//! docs and README, so the overall shape should be right. The two specific
//! spots most likely to need a fix once you have real compiler errors:
//!   1. How arguments get attached to CallToolRequestParams (the exact
//!      builder method name may differ from what's written below).
//!   2. How to extract text back out of the tool result's content blocks
//!      (the exact accessor method may differ).
//! If `cargo build` fails inside this file specifically, paste the error —
//! that's expected to be more useful here than in any other Phase 4 file.

use crate::tool_registry::{ToolDefinition, ToolOrigin};
use rmcp::{
    model::CallToolRequestParams,
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use serde_json::Value;
use tokio::process::Command;

/// Connects to the configured MCP server, lists its tools, and disconnects.
/// Called once per agent run to build the tool list the model sees.
pub async fn list_tools(command: &str, args: &[String]) -> Result<Vec<ToolDefinition>, String> {
    let cmd = Command::new(command);
    let child = TokioChildProcess::new(cmd.configure(|c| {
        for a in args {
            c.arg(a);
        }
    }))
    .map_err(|e| format!("failed to spawn MCP server \"{}\": {}", command, e))?;

    let client = ()
        .serve(child)
        .await
        .map_err(|e| format!("failed to connect to MCP server \"{}\": {}", command, e))?;

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| format!("failed to list tools from MCP server: {}", e))?;

    let definitions = tools
        .into_iter()
        .map(|t| ToolDefinition {
            name: t.name.to_string(),
            description: t.description.clone().unwrap_or_default().to_string(),
            parameters: serde_json::to_value(&t.input_schema)
                .unwrap_or_else(|_| serde_json::json!({ "type": "object" })),
            origin: ToolOrigin::Mcp,
        })
        .collect();

    let _ = client.cancel().await;
    Ok(definitions)
}

/// Connects fresh, calls one tool by name with the given JSON arguments,
/// and returns its text output.
pub async fn call_tool(command: &str, args: &[String], tool_name: &str, tool_args: Value) -> Result<String, String> {
    let cmd = Command::new(command);
    let child = TokioChildProcess::new(cmd.configure(|c| {
        for a in args {
            c.arg(a);
        }
    }))
    .map_err(|e| format!("failed to spawn MCP server \"{}\": {}", command, e))?;

    let client = ()
        .serve(child)
        .await
        .map_err(|e| format!("failed to connect to MCP server \"{}\": {}", command, e))?;

    // ⚠️ Most likely spot to need a fix: attaching tool_args here.
    let params = CallToolRequestParams {
        name: tool_name.to_string().into(),
        arguments: tool_args.as_object().cloned(),
        meta: None,
        task: None,
    };

    let result = client
        .call_tool(params)
        .await
        .map_err(|e| format!("MCP tool \"{}\" call failed: {}", tool_name, e))?;

    let _ = client.cancel().await;

    // ⚠️ Second most likely spot to need a fix: extracting text content.
    let text = result
        .content
        .iter()
        .filter_map(|block| block.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(text)
}
