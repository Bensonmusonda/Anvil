use ignore::WalkBuilder;
use std::path::{Path, PathBuf};
use serde::Serialize;
use nucleo::{Nucleo, Config};

#[derive(Serialize)]
pub struct FuzzyResult {
    pub path: String,
    pub score: u32,
}

pub fn find_files(cwd: &Path, query: &str) -> Result<Vec<FuzzyResult>, String> {
    let mut files = Vec::new();
    let walker = WalkBuilder::new(cwd)
        .hidden(true)
        .git_ignore(true)
        .build();

    for result in walker {
        if let Ok(entry) = result {
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                if let Ok(rel_path) = entry.path().strip_prefix(cwd) {
                    files.push(rel_path.to_string_lossy().to_string());
                }
            }
        }
    }

    // Basic implementation: if query is empty, return all files
    if query.is_empty() {
        return Ok(files.into_iter().take(100).map(|path| FuzzyResult { path, score: 0 }).collect());
    }

    // Using nucleo for fuzzy matching
    let mut nucleo = Nucleo::<String>::new(Config::DEFAULT, std::sync::Arc::new(|| ()), None, 1);
    let injector = nucleo.injector();
    
    for file in files {
        injector.push(file, |f, cols| cols[0] = f.clone().into());
    }
    
    nucleo.pattern.reparse(
        0,
        query,
        nucleo::pattern::CaseMatching::Ignore,
        nucleo::pattern::Normalization::Smart,
        false,
    );

    nucleo.tick(10); // allow it to process

    let snapshot = nucleo.snapshot();
    let mut results = Vec::new();
    
    for item in snapshot.matched_items(..snapshot.matched_item_count().min(100)) {
        results.push(FuzzyResult {
            path: item.data.clone(),
            score: 0,
        });
    }

    Ok(results)
}
