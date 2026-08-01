use crate::config::Config;
use crate::tool_registry::{ToolDefinition, ToolOrigin};
use crate::{mcp_host, tools_native};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::Path;
use tauri::Emitter;

const MAX_ITERATIONS: usize = 5;

pub async fn run(
    config: &Config,
    prompt: &str,
    tools: &[ToolDefinition],
    workspace_root: Option<&Path>,
    mcp_command: Option<(&str, &[String])>,
    override_provider: Option<&str>,
    override_model: Option<&str>,
    system_prompt: Option<&str>,
    history: &[Value],
    app: &tauri::AppHandle,
    request_id: &str,
) -> Result<String, String> {
    let (provider_name, model): (String, String) = if let Some(p) = override_provider {
        let model = override_model
            .ok_or("a model override must be provided alongside a provider override")?
            .to_string();
        (p.to_string(), model)
    } else {
        let route = config
            .routing
            .get("chat")
            .ok_or("no routing configured for purpose \"chat\"")?;
        (route.provider.clone(), route.model.clone())
    };

    let provider = config
        .providers
        .get(&provider_name)
        .ok_or_else(|| format!("unknown provider \"{}\"", provider_name))?;
    let api_key = config.resolve_api_key(&provider_name)?;
    let url = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));

    let mut messages = Vec::new();
    if let Some(sys) = system_prompt {
        if !sys.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
    }
    messages.extend_from_slice(history);
    messages.push(json!({ "role": "user", "content": prompt }));

    let tool_defs: Vec<Value> = tools.iter().map(|t| t.to_openai_tool()).collect();
    let client = reqwest::Client::new();

    // Concatenation of every round's streamed content, in order — including
    // any commentary a model emits alongside tool_calls before its final
    // answer. That interim text gets streamed live too, which reads as the
    // agent narrating what it's doing rather than going silent during tool
    // calls. This full string, not just the last round's text, is what
    // gets returned and stored in conversation history.
    let mut full_text = String::new();

    for _ in 0..MAX_ITERATIONS {
        let body = json!({
            "model": model,
            "messages": messages,
            "tools": tool_defs,
            "stream": true
        });

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request to provider failed: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.map_err(|e| e.to_string())?;
            return Err(format!("provider returned HTTP {}: {}", status, text));
        }

        let (round_content, round_tool_calls) =
            stream_chat_completion(response, app, request_id).await?;
        full_text.push_str(&round_content);

        if round_tool_calls.is_empty() {
            return Ok(full_text);
        }

        messages.push(json!({
            "role": "assistant",
            "content": if round_content.is_empty() { Value::Null } else { json!(round_content) },
            "tool_calls": round_tool_calls
        }));

        for call in &round_tool_calls {
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

/// Consumes an SSE chat-completion stream, emitting each content token as
/// an "agent-token" event tagged with `request_id` (so the frontend can
/// ignore stale events from a superseded request). Returns the round's
/// full content string plus any tool_calls, reassembled from fragmented
/// deltas keyed by their `index` field — OpenAI's streaming format sends
/// a tool call's id/name once and its arguments in pieces across many
/// chunks.
async fn stream_chat_completion(
    response: reqwest::Response,
    app: &tauri::AppHandle,
    request_id: &str,
) -> Result<(String, Vec<Value>), String> {
    let mut byte_stream = response.bytes_stream();
    let mut buf = String::new();
    let mut content = String::new();
    let mut tool_calls: std::collections::BTreeMap<u64, (String, String, String)> =
        std::collections::BTreeMap::new();

    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {}", e))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let payload = line["data:".len()..].trim();
            if payload == "[DONE]" {
                continue;
            }

            let parsed: Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(_) => continue, // partial/malformed line — skip rather than fail the whole stream
            };
            let delta = &parsed["choices"][0]["delta"];

            if let Some(text) = delta["content"].as_str() {
                if !text.is_empty() {
                    content.push_str(text);
                    let _ = app.emit("agent-token", json!({ "requestId": request_id, "token": text }));
                }
            }

            if let Some(calls) = delta["tool_calls"].as_array() {
                for call in calls {
                    let idx = call["index"].as_u64().unwrap_or(0);
                    let entry = tool_calls.entry(idx).or_insert_with(|| {
                        (String::new(), String::new(), String::new())
                    });
                    if let Some(id) = call["id"].as_str() {
                        entry.0 = id.to_string();
                    }
                    if let Some(name) = call["function"]["name"].as_str() {
                        entry.1.push_str(name);
                    }
                    if let Some(args) = call["function"]["arguments"].as_str() {
                        entry.2.push_str(args);
                    }
                }
            }
        }
    }

    let tool_calls_value: Vec<Value> = tool_calls
        .into_iter()
        .map(|(idx, (id, name, args))| {
            json!({
                "index": idx,
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": args }
            })
        })
        .collect();

    Ok((content, tool_calls_value))
}