//! Model-Agnostic Routing & Proxy Interface (spec §4).
//! Adapted from daemon/src/provider.rs — see config.rs for why this is
//! duplicated rather than shared, for now.

use crate::config::Config;
use serde_json::json;

/// `override_provider`/`override_model` bypass the purpose→routing lookup
/// entirely when both are present (the model-switcher UI always sends
/// both together — see `main.rs::ai_complete`). `system_prompt`, if
/// non-empty, is sent as the first message.
pub async fn complete(
    config: &Config,
    purpose: &str,
    prompt: &str,
    override_provider: Option<&str>,
    override_model: Option<&str>,
    system_prompt: Option<&str>,
) -> Result<String, String> {
    let (provider_name, model): (String, String) = if let Some(p) = override_provider {
        let model = override_model
            .ok_or("a model override must be provided alongside a provider override")?
            .to_string();
        (p.to_string(), model)
    } else {
        // Existing purpose-based lookup, with a fallback to "chat" for any
        // purpose that doesn't warrant its own dedicated routing entry:
        // "inline" (pre-existing) and now "title" (chat-session naming,
        // added alongside chat persistence) both fall back to "chat" if the
        // user's config.json has no dedicated entry for them, so neither
        // breaks existing setups that only configure "chat".
        let route = config
            .routing
            .get(purpose)
            .or_else(|| {
                if purpose == "inline" || purpose == "title" {
                    config.routing.get("chat")
                } else {
                    None
                }
            })
            .ok_or_else(|| format!("no routing configured for purpose \"{}\"", purpose))?;
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
    messages.push(json!({ "role": "user", "content": prompt }));

    let body = json!({
        "model": model,
        "messages": messages,
        "stream": false
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request to provider \"{}\" at {} failed: {}", provider_name, url, e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(format!("provider \"{}\" returned HTTP {}: {}", provider_name, status, text));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!("provider \"{}\" returned non-JSON response: {} — body: {}", provider_name, e, text)
    })?;

    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "provider \"{}\" response missing choices[0].message.content — full response: {}",
                provider_name, text
            )
        })
}