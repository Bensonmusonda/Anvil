//! Anvil Daemon — Phase 1: Backend Routing Prototype
//!
//! Deliberately has no UI dependency. Two ways to exercise it:
//!   - Single-shot:   anvil-daemon --config anvil.config.json --purpose chat "your message"
//!   - Interactive:   anvil-daemon --config anvil.config.json --purpose chat
//!                    (reads lines from stdin, prints responses, "exit" to quit —
//!                     this is the "raw stdin/stdout agent script loop" from spec §6)

mod config;
mod provider;

use anyhow::{Context, Result};
use config::Config;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();

    let mut config_path = PathBuf::from("anvil.config.json");
    let mut purpose = "chat".to_string();
    let mut inline_prompt: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--config" => {
                i += 1;
                config_path = PathBuf::from(
                    args.get(i).context("--config requires a path argument")?,
                );
            }
            "--purpose" => {
                i += 1;
                purpose = args
                    .get(i)
                    .context("--purpose requires a value, e.g. chat or inline")?
                    .clone();
            }
            other => {
                inline_prompt = Some(other.to_string());
            }
        }
        i += 1;
    }

    let config = Config::load(&config_path)
        .with_context(|| format!("could not load config from {}", config_path.display()))?;

    eprintln!(
        "Anvil daemon (Phase 1 prototype) — purpose=\"{}\", config={}",
        purpose,
        config_path.display()
    );

    // Single-shot mode: good for scripted tests, e.g.
    //   anvil-daemon --config anvil.config.json --purpose chat "hello"
    if let Some(prompt) = inline_prompt {
        match provider::complete(&config, &purpose, &prompt).await {
            Ok(response) => println!("{}", response),
            Err(err) => {
                eprintln!("error: {:#}", err);
                std::process::exit(1);
            }
        }
        return Ok(());
    }

    // Interactive stdin/stdout agent loop.
    eprintln!("Interactive mode. Type a message and press Enter. Type \"exit\" to quit.\n");
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    loop {
        print!("> ");
        stdout.flush().ok();

        let mut line = String::new();
        let bytes_read = stdin
            .lock()
            .read_line(&mut line)
            .context("failed to read from stdin")?;

        if bytes_read == 0 {
            break; // EOF
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "exit" {
            break;
        }

        match provider::complete(&config, &purpose, line).await {
            Ok(response) => println!("{}\n", response),
            Err(err) => eprintln!("error: {:#}\n", err),
        }
    }

    Ok(())
}
