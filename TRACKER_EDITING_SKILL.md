# TRACKER_EDITING_SKILL.md

Read this before making ANY edit to `ANVIL_PROJECT_TRACKER.md`. This file is an append-only log, not a document to improve. Treat it the way you'd treat a changelog or a database table — new rows get added, existing structure doesn't get "cleaned up," even if it looks inconsistent or could be phrased better.

## Non-negotiable rules

1. **Never rewrite the whole file.** Every edit is a targeted insertion at a specific, named location — a specific table, under a specific heading, appending to a specific list. If you're about to output the entire file's contents to make a change, stop — that's the failure mode this file exists to prevent.
2. **Never renumber existing sections.** If a new section needs to be inserted between two numbered ones, either give it a decimal (e.g. `6.5` between `6` and `7`) or add it at the end and leave the numbering gap — do not renumber everything below it. Renumbering breaks any external reference to "see §8" made elsewhere.
3. **Never change existing table structure** (column headers, column order) to accommodate new data. Add rows, not new columns, unless explicitly told to restructure a table.
4. **Never reword, "improve," or shorten existing entries.** An awkwardly phrased Gotchas Log entry from three months ago stays exactly as awkward as it was written. This is a historical record, not a document meant to read well end-to-end.
5. **Never reformat markdown style** (heading levels, list bullet style, table alignment) to be "more consistent" across the file. Inconsistent formatting across entries added at different times is expected and fine.
6. **When asked to "update the tracker with X," insert exactly what's given, in the exact section named** — don't infer a better place to put it, don't split it across sections, don't add commentary explaining the change.

## What a correct tracker edit looks like

Given an instruction like:
> Add this to §10 Gotchas Log:
> `| 2026-07-08 | X happened | Y was the cause | Z fixed it |`

The correct action is a single targeted insertion of that exact row into that exact table, with everything else in the file byte-identical to before. If you're not sure exactly where a section is, ask or search for the heading text — don't guess by reading the whole file's "vibe" and deciding where things "should" go.

## Before finishing any tracker edit

Do a mental (or literal) diff against the previous version: if more than the specifically-requested lines changed, undo and redo it as a targeted edit. A `git diff` on this file after your change should show ONLY the new lines added (plus maybe a couple of surrounding context lines) — if it shows large deleted/re-added blocks, formatting changed something it shouldn't have.

## Why this matters more here than in code

Code changes get reviewed by compiling and testing. This file has no compiler to catch a silent reformat — the only thing that catches it is someone noticing the file "looks different" days later, by which point the original phrasing/structure is already lost. Treat that absence of a safety net as a reason for MORE caution here, not less.

## Correct workflow for updating these files

**Do:**
- Make a single, targeted insertion in the exact location requested
- Keep all existing content and formatting unchanged
- Verify the diff shows only new lines

**Don't:**
- Reformat the entire file for consistency
- Reword existing entries for clarity
- Reorganize sections
- Output the whole file even though you're only changing one table
