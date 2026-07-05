//! Model-Agnostic Routing & Proxy Interface (spec §4).
//! Adapted from daemon/src/provider.rs — see config.rs for why this is
//! duplicated rather than shared, for now.

use crate::config::Config;
use serde_json::json;

pub async fn complete(config: &Config, purpose: &str, prompt: &str) -> Result<String, String> {
    let route = config
        .routing
        .get(purpose)
        .ok_or_else(|| format!("no routing configured for purpose \"{}\"", purpose))?;

    let provider = config
        .providers
        .get(&route.provider)
        .ok_or_else(|| format!("routing references unknown provider \"{}\"", route.provider))?;

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
        .map_err(|e| format!("request to provider \"{}\" at {} failed: {}", route.provider, url, e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "provider \"{}\" returned HTTP {}: {}",
            route.provider, status, text
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "provider \"{}\" returned non-JSON response: {} — body: {}",
            route.provider, e, text
        )
    })?;

    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "provider \"{}\" response missing choices[0].message.content — full response: {}",
                route.provider, text
            )
        })
}
