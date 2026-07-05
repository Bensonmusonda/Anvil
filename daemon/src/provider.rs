//! Model-Agnostic Routing & Proxy Interface (spec §4)
//!
//! Standardizes every provider call into an OpenAI-compatible payload
//! before sending, so switching providers or models is a config change,
//! never a code change here.

use crate::config::Config;
use anyhow::{bail, Context, Result};
use serde_json::json;

/// Sends `prompt` to whichever provider/model is routed for `purpose`
/// (e.g. "chat" or "inline"), and returns the completion text.
pub async fn complete(config: &Config, purpose: &str, prompt: &str) -> Result<String> {
    let route = config
        .routing
        .get(purpose)
        .ok_or_else(|| anyhow::anyhow!("no routing configured for purpose \"{}\"", purpose))?;

    let provider = config
        .providers
        .get(&route.provider)
        .ok_or_else(|| anyhow::anyhow!("routing references unknown provider \"{}\"", route.provider))?;

    let api_key = config.resolve_api_key(&route.provider)?;
    let url = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));

    let body = json!({
        "model": route.model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .with_context(|| format!("request to provider \"{}\" at {} failed", route.provider, url))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .context("failed to read response body")?;

    if !status.is_success() {
        bail!(
            "provider \"{}\" returned HTTP {}: {}",
            route.provider,
            status,
            text
        );
    }

    let parsed: serde_json::Value = serde_json::from_str(&text).with_context(|| {
        format!(
            "provider \"{}\" returned non-JSON or unexpected response: {}",
            route.provider, text
        )
    })?;

    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "provider \"{}\" response missing choices[0].message.content — full response: {}",
                route.provider,
                text
            )
        })?;

    Ok(content.to_string())
}
