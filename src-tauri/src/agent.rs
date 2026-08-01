use crate::config::Config;
use crate::tool_registry::{ToolDefinition, ToolOrigin};
use crate::{mcp_host, tools_native};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::Path;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

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
    cancel: CancellationToken,   // <-- new
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

    let mut full_text = String::new();

    for _ in 0..MAX_ITERATIONS {
        let _ = app.emit("agent-round-start", json!({ "requestId": request_id }));   // <-- new

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

        let (round_content, round_tool_calls, was_cancelled) =
            stream_chat_completion(response, app, request_id, &cancel).await?;
        full_text.push_str(&round_content);

        // Stopped mid-stream — return whatever was generated as the final
        // answer rather than continuing into another tool-call round.
        if was_cancelled {
            return Ok(full_text);
        }

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

/// Extracts reasoning/thinking text from a delta object, handling all three
/// shapes your configured providers actually use: DeepSeek's
/// `reasoning_content`, Ollama's OpenAI-compat `reasoning`, and OpenRouter's
/// structured `reasoning_details` array. Checked in this priority order
/// (not accumulated) because OpenRouter sends both a flat `reasoning` string
/// and the structured array for the same underlying text — summing them
/// would duplicate it.
fn extract_reasoning_text(delta: &Value) -> String {
    if let Some(details) = delta["reasoning_details"].as_array() {
        let mut out = String::new();
        for d in details {
            if let Some(s) = d["text"].as_str() {
                out.push_str(s);
            }
        }
        return out;
    }
    if let Some(s) = delta["reasoning_content"].as_str() {
        return s.to_string();
    }
    if let Some(s) = delta["reasoning"].as_str() {
        return s.to_string();
    }
    String::new()
}

/// Consumes an SSE chat-completion stream, racing each chunk against
/// `cancel`. Returns (content, tool_calls, was_cancelled) — `was_cancelled`
/// tells the caller to stop the whole agent loop rather than proceed into
/// another round, since a user-initiated stop shouldn't trigger tool calls
/// off a truncated response.
async fn stream_chat_completion(
    response: reqwest::Response,
    app: &tauri::AppHandle,
    request_id: &str,
    cancel: &CancellationToken,
) -> Result<(String, Vec<Value>, bool), String> {
    let mut byte_stream = response.bytes_stream();
    let mut buf = String::new();
    let mut content = String::new();
    let mut tool_calls: std::collections::BTreeMap<u64, (String, String, String)> =
        std::collections::BTreeMap::new();
    let mut was_cancelled = false;

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                was_cancelled = true;
                break;
            }
            chunk = byte_stream.next() => {
                let chunk = match chunk {
                    Some(c) => c.map_err(|e| format!("stream read error: {}", e))?,
                    None => break, // stream ended naturally
                };
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
                        Err(_) => continue,
                    };
                    let delta = &parsed["choices"][0]["delta"];

                    if let Some(text) = delta["content"].as_str() {
                        if !text.is_empty() {
                            content.push_str(text);
                            let _ = app.emit("agent-token", json!({ "requestId": request_id, "token": text }));
                        }
                    }

                    let reasoning_text = extract_reasoning_text(delta);   // <-- new
                    if !reasoning_text.is_empty() {                       // <-- new
                        let _ = app.emit("agent-reasoning-token", json!({ "requestId": request_id, "token": reasoning_text })); // <-- new
                    }                                                     // <-- new

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

    Ok((content, tool_calls_value, was_cancelled))
}