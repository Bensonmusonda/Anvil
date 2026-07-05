//! Config Mapping Strategy (spec §4.1). Duplicated from daemon/src/config.rs
//! — see that file's comment for why. Phase 4 adds mcp_servers, used only
//! by src-tauri (the daemon crate stays scoped to provider routing).

use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Clone)]
pub struct ProviderConfig {
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RouteConfig {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct ExtensionsConfig {
    #[serde(default)]
    pub enabled: Vec<String>,
    #[serde(default)]
    pub search_paths: Vec<String>,
}

/// A single MCP server to spawn as a child process and connect to over
/// stdio. Phase 4 supports configuring one; agent_run uses the first entry
/// found. Multiple concurrent MCP servers are a later-phase concern.
#[derive(Debug, Deserialize, Clone)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub providers: HashMap<String, ProviderConfig>,
    pub routing: HashMap<String, RouteConfig>,
    #[serde(default)]
    pub extensions: ExtensionsConfig,
    #[serde(default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

impl Config {
    pub fn default_path() -> Result<PathBuf, String> {
        let home = std::env::var("HOME")
            .map_err(|_| "HOME environment variable not set".to_string())?;
        Ok(PathBuf::from(home).join(".anvil").join("config.json"))
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = fs::read_to_string(path).map_err(|e| {
            format!(
                "failed to read config at {}: {} — copy daemon/anvil.config.example.json there and fill in your keys",
                path.display(),
                e
            )
        })?;
        let config: Config =
            serde_json::from_str(&raw).map_err(|e| format!("failed to parse config JSON: {}", e))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        for (purpose, route) in &self.routing {
            if !self.providers.contains_key(&route.provider) {
                return Err(format!(
                    "routing.{} references unknown provider \"{}\"",
                    purpose, route.provider
                ));
            }
        }
        Ok(())
    }

    pub fn resolve_api_key(&self, provider_name: &str) -> Result<String, String> {
        let provider = self
            .providers
            .get(provider_name)
            .ok_or_else(|| format!("unknown provider \"{}\"", provider_name))?;

        if let Some(var_name) = provider.api_key.strip_prefix("ENV_") {
            std::env::var(var_name).map_err(|_| {
                format!(
                    "environment variable {} is not set (required for provider \"{}\")",
                    var_name, provider_name
                )
            })
        } else {
            Ok(provider.api_key.clone())
        }
    }
}
