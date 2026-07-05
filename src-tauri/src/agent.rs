//! Phase 4 agent loop. Sends the prompt + registered tools to the "chat"
//! provider using OpenAI-compatible function calling, executes any
//! requested tool calls (dispatching to native or MCP based on origin),
//! feeds results back as "tool" role messages, and repeats until the model
//! returns a plain-text answer or MAX_ITERATIONS is hit (a safety net
//! against infinite tool-call loops, not expected to trigger normally).

use crate::config::Config;
use crate::tool_registry::{ToolDefinition, ToolOrigin};
use crate::{mcp_host, tools_native};
use serde_json::{json, Value};
use std::path::Path;

const MAX_ITERATIONS: usize = 5;

pub async fn run(
    config: &Config,
    prompt: &str,
    tools: &[ToolDefinition],
    workspace_root: Option<&Path>,
    mcp_command: Option<(&str, &[String])>,
) -> Result<String, String> {
    let route = config
        .routing
        .get("chat")
        .ok_or("no routing configured for purpose \"chat\"")?;
    let provider = config
        .providers
        .get(&route.provider)
        .ok_or_else(|| format!("unknown provider \"{}\"", route.provider))?;
    let api_key = config.resolve_api_key(&route.provider)?;
    let url = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));

    let mut messages = vec![json!({ "role": "user", "content": prompt })];
    let tool_defs: Vec<Value> = tools.iter().map(|t| t.to_openai_tool()).collect();
    let client = reqwest::Client::new();

    for _ in 0..MAX_ITERATIONS {
        let body = json!({
            "model": route.model,
            "messages": messages,
            "tools": tool_defs,
            "stream": false
        });

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request to provider failed: {}", e))?;

        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("provider returned HTTP {}: {}", status, text));
        }

        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| format!("non-JSON response: {} — body: {}", e, text))?;

        let choice = &parsed["choices"][0]["message"];
        let tool_calls = choice["tool_calls"].as_array();

        // No tool calls — the model gave a final answer.
        if tool_calls.map_or(true, |calls| calls.is_empty()) {
            return choice["content"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| format!("no content or tool_calls in response: {}", text));
        }

        messages.push(choice.clone());

        for call in tool_calls.unwrap() {
            let call_id = call["id"].as_str().unwrap_or("").to_string();
            let fn_name = call["function"]["name"].as_str().unwrap_or("").to_string();
            let args_str = call["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));

            let tool_def = tools.iter().find(|t| t.name == fn_name);
            let result = match tool_def.map(|t| &t.origin) {
                Some(ToolOrigin::Native) => tools_native::execute(&fn_name, &args, workspace_root),
                Some(ToolOrigin::Mcp) => {
                    if let Some((cmd, cmd_args)) = mcp_command {
                        mcp_host::call_tool(cmd, cmd_args, &fn_name, args).await
                    } else {
                        Err("model requested an MCP tool but no MCP server is configured".to_string())
                    }
                }
                None => Err(format!("model requested unknown tool \"{}\"", fn_name)),
            };

            let result_text = result.unwrap_or_else(|e| format!("ERROR: {}", e));

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result_text
            }));
        }
    }

    Err(format!(
        "agent did not reach a final answer within {} tool-call rounds",
        MAX_ITERATIONS
    ))
}
