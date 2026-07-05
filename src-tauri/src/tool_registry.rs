//! Tool Registry Service (spec §4/§5, and the anvil-extension-authoring
//! skill's rule 5): every tool — native or MCP-bridged — presents an
//! identical schema shape to the agent. The agent never needs to know a
//! tool's origin; only the dispatcher (agent.rs) does.

use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub enum ToolOrigin {
    Native,
    Mcp,
}

#[derive(Clone, Debug)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value, // JSON schema, OpenAI function-calling shape
    pub origin: ToolOrigin,
}

impl ToolDefinition {
    /// Converts to the OpenAI-compatible tool-calling shape the provider
    /// expects. This is the single place that shape is defined — both
    /// native and MCP tools flow through it identically.
    pub fn to_openai_tool(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters
            }
        })
    }
}
