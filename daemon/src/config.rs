//! Config Mapping Strategy (spec §4.1)
//!
//! Loads and validates the provider/routing configuration. Kept strict on
//! purpose: a routing entry pointing at a provider that doesn't exist should
//! fail loudly at startup, not silently at request time.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

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

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub providers: HashMap<String, ProviderConfig>,
    pub routing: HashMap<String, RouteConfig>,
    #[serde(default)]
    pub extensions: ExtensionsConfig,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file at {}", path.display()))?;
        let config: Config = serde_json::from_str(&raw)
            .with_context(|| "failed to parse config JSON — check it against anvil.config.example.json")?;
        config.validate()?;
        Ok(config)
    }

    /// Fails loudly at load time if routing references a provider that
    /// doesn't exist, rather than failing confusingly at request time.
    fn validate(&self) -> Result<()> {
        for (purpose, route) in &self.routing {
            if !self.providers.contains_key(&route.provider) {
                bail!(
                    "routing.{} references unknown provider \"{}\" — check the providers block in your config",
                    purpose, route.provider
                );
            }
        }
        Ok(())
    }

    /// Resolves an api_key value. Values prefixed with "ENV_" are read from
    /// the named environment variable at request time, so real keys never
    /// need to be written into a config file that might get committed.
    pub fn resolve_api_key(&self, provider_name: &str) -> Result<String> {
        let provider = self
            .providers
            .get(provider_name)
            .ok_or_else(|| anyhow::anyhow!("unknown provider \"{}\"", provider_name))?;

        if let Some(var_name) = provider.api_key.strip_prefix("ENV_") {
            std::env::var(var_name).with_context(|| {
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
