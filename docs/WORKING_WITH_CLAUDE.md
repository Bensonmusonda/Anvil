# Working with Claude on Anvil: A Productivity Guide

This guide documents patterns that have proven effective for working with Claude on the Anvil project. It's based on real experience from Phases 0–7 and reflects what works, what doesn't, and why.

---

## TL;DR: The Pattern That Works

1. **Use Claude for architecture, design, and review.** Not for hands-on code editing (that's Antigravity IDE's job).
2. **Always paste `ANVIL_STATE.md` first** — gives Claude the big picture in 2 minutes instead of 20.
3. **Ask narrow, specific questions** — "How should I structure the delete_path handler?" beats "How should I build Phase 7?"
4. **Paste relevant files only** — see `CLAUDE_CONTEXT_FILES.md` for what to include per task.
5. **Use Claude to review diffs and spot bugs** — this is where the real value is after you've written code.
6. **Record decisions in `ANVIL_PROJECT_TRACKER.md`** — prevents the same question from re-surfacing.
7. **Keep Claude as advisor, not implementer** — once you've decided on an approach, do the coding yourself (or in Antigravity), then get Claude to review.

---

## Part 1: Maximizing Context Efficiency

Claude has a finite token budget per conversation. Here's how to stay under it while covering ground.

### 1.1 Start with `ANVIL_STATE.md`

**Always paste this first, before anything else.**

```
User: Here's the current state of the Anvil project:

[paste ANVIL_STATE.md in full]

I'm working on [your task]. Here's what I need help with...
```

**Why:** `ANVIL_STATE.md` gives Claude:
- What the project is (1 paragraph)
- What's done and what's not (status section)
- The complete file map with responsibilities (30 lines, replaces pasting 20 files)
- Where to find detailed history (`ANVIL_PROJECT_TRACKER.md`)

**Token cost:** ~400 tokens. **Value:** ~4000 tokens' worth of "wait, which file does X again?"

### 1.2 The "Relevant Files Only" Tier System

Use the tier system from `CLAUDE_CONTEXT_FILES.md`:

**Tier 1: Always (if starting fresh)**
```
- ANVIL_STATE.md (already pasted above)
- docs/LANGUAGE_REGISTRY_REFACTOR.md (if discussing architecture)
- ANVIL_PROJECT_TRACKER.md (if you need to reference decisions)
```

**Tier 2: Feature-specific (add based on what you're building)**

Example: "I'm adding delete_path and rename_path commands for Phase 7"
```
- src-tauri/src/main.rs (to see the pattern for create_file/create_folder)
- src-tauri/src/history.rs (to understand snapshot relocation needed for rename)
- src/fileTree.js (to see where the UI calls would land)
```

**Don't paste:**
- Entire `src/` or `src-tauri/src/` directories unless you're doing a deep refactor
- Vendored code (`vendor/`, `target/`, `node_modules/`)
- Your entire `src-tauri/Cargo.toml` unless you're debugging a dep issue
- Old/parked code

**Token cost:** ~1000 tokens for a focused Tier 2 set. **Value:** precision without drowning in noise.

### 1.3 Ask Narrow Questions

**Bad:**
> I'm implementing Phase 7 (File/Folder CRUD). How should I approach this?

**Good:**
> I'm adding `delete_path` and `rename_path` commands to `src-tauri/src/main.rs`. 
> 1. For delete, should I use the `trash` crate or shell out to `rm -rf`?
> 2. For rename, `history.rs` has snapshots per file — should I relocate them?
> Here's the pattern used by `create_file` for reference: [snippet]

**Why:** Narrow questions produce narrow, useful answers. Broad questions invite generic advice that wastes tokens.

### 1.4 Structure Pastes for Scannability

When pasting code, include context:

```
## Current Structure (src-tauri/src/main.rs, lines 160–175)

#[tauri::command]
fn create_file(parent_dir: String, name: String) -> Result<String, String> {
    // ... implementation ...
}

## Question

I need to add `delete_path` with similar error handling. Should it:
- Option A: Return the deleted path (like create_file returns the created path)?
- Option B: Return just `Result<(), String>` since nothing was "created"?
```

**Why:** Claude scans headers faster than raw text. Explicit options focus the response.

---

## Part 2: Using Claude for Architecture & Design

This is where Claude adds the most value for a project like Anvil. Here's how to get the best insights.

### 2.1 Design Review Before Coding

**Pattern:**
```
I'm working on [feature]. Here's my proposed approach:

1. [Plan A: implementation strategy]
2. [Data structures involved]
3. [Where it integrates with existing code]
4. [Open questions/concerns]

Before I code this, does this seem sound? Any gotchas I'm missing?
```

**Example from Phase 5.5 (Language Registry):**

User should have asked (but didn't, in retrospect):
```
I want to support multi-language LSP. My plan:
1. Create a trait `LanguageServer` with `detect()` and `spawn()`
2. Implement it for Rust, Python, Go
3. Call `detect_language()` in `start_lsp`
4. On the frontend, add a `languages.js` registry with the same data

Concerns:
- Is this going to make LSP spawn logic too inflexible later?
- Should language-specific settings live in config.json?

Does this direction seem right?
```

**Why:** Getting design feedback before coding saves 2–3 hours of refactoring. Claude is good at spotting architectural problems.

### 2.2 "Is This Decision Locked?" Checks

Before coding, ask Claude to check if a decision already exists:

```
I'm about to implement [X]. Before I do, is there already a locked decision about this?
I'll paste my ANVIL_PROJECT_TRACKER.md so you can scan §2 (Locked Decisions).
```

**Example:**
- "Should LSP support multiple servers at once?" → Check if this was decided in Phase 5
- "What's the permission model for extensions?" → Check Phase 4 decisions
- "Should config auto-reload or require restart?" → Check Phase 1 decisions

**Why:** Prevents re-litigating settled questions. Respects the incremental, decision-based approach.

### 2.3 Spotting Architectural Debt Early

Ask Claude to review a new feature through the lens of "does this create debt?":

```
I just implemented [feature]. Before I commit it, can you check if it:
1. Violates any of the locked decisions in ANVIL_PROJECT_TRACKER.md?
2. Creates a precedent that would be hard to undo (debt)?
3. Adds complexity that could have been deferred?

Here's the code:
[snippet]
```

**Example from Phase 5:**
If you'd asked this about the LSP implementation, Claude would have flagged:
> "Your LSP handler hard-codes `rust-analyzer`. This isn't debt yet, but once you add Python, you'll duplicate a lot of this code. Consider if the Language Registry refactor should happen now instead of Phase 5.5."

**Why:** Early debt detection saves refactors later.

---

## Part 3: Using Claude for Code Review

This is where Claude's value is highest and most reliable.

### 3.1 Post-Implementation Code Review

**After you've written code (in Antigravity or your editor), paste it for review:**

```
I just implemented [feature]. Here's the code:

[full implementation]

Can you spot any issues?
1. Edge cases I'm missing?
2. Panic/unwrap risks?
3. Anything that violates our architecture (see ANVIL_STATE.md)?
4. Performance concerns?
```

**Why:** Claude is excellent at spotting bugs in code it didn't write. Fresh eyes catch things you miss after staring at code for 30 minutes.

### 3.2 Bug Diagnosis

**When something's broken, Claude can help diagnose if you give it the right info:**

```
Symptom: [What's happening]
Expected: [What should happen]
Environment: [OS, Rust version, etc.]

I've added this code: [snippet]

I've verified:
- [ ] It compiles
- [ ] The function is actually being called (via debug print)
- [ ] The error is not in function X (I tested X separately)

What could be wrong?
```

**Compare to:**
```
The delete command doesn't work. Why?
```

The second one is unanswerable. The first one gives Claude a fighting chance.

### 3.3 Diff Review

When you've made changes, paste the diff (not the whole files) and ask Claude to review:

```
I'm about to commit this change to src-tauri/src/main.rs. Any issues?

--- a/src-tauri/src/main.rs
+++ b/src-tauri/src/main.rs
@@ -160,6 +160,12 @@
 #[tauri::command]
+fn delete_path(path: String) -> Result<(), String> {
+    // ... implementation ...
+}
```

**Why:** Diff review is fast (Claude scans only what changed), and it surfaces the context ("oh, this is next to create_file, so it should follow the same error handling pattern").

---

## Part 4: The Gotchas — What Doesn't Work

Learn from mistakes made during Phases 0–7.

### 4.1 Don't Ask Claude to Write Code Directly into Your Repo

**Bad workflow:**
1. Claude writes a full implementation of Phase 7
2. You copy-paste it into your editor
3. You commit it
4. It has subtle bugs you didn't catch

**Better workflow:**
1. You write Phase 7 in your editor
2. Claude reviews it
3. You fix issues Claude spotted
4. You commit it

**Why:** Code you write yourself, reviewed by Claude, is higher quality than code Claude writes for you. You understand it, can debug it, and the review catches Claude's mistakes too.

### 4.2 Don't Trust Claude's Memory Between Sessions

**Bad:**
Session 1: Claude helps you design Phase 7.
Session 2 (new chat): "Recall what we discussed about Phase 7 deletion..."

Claude likely won't remember. Context between sessions is lost.

**Better:**
Record the decision in `ANVIL_PROJECT_TRACKER.md` during Session 1.
In Session 2, paste the tracker and say: "Here's where we landed on deletion strategy..."

### 4.3 Don't Assume Claude Knows Your Codebase Better Than You

**Symptom:** Claude suggests a change that seems smart but breaks something.

**Why:** Claude's knowledge of your code is what you tell it in this session. It doesn't have `git log` or the Gotchas Log. If you don't mention that `history.rs` has side effects, Claude can't know `rename_path` needs to coordinate with it.

**Defense:** Always mention constraints when asking architecture questions.

### 4.4 Don't Ask "Why Doesn't This Work?" Without Pasting the Code

**Bad:**
> The LSP completion isn't showing suggestions. Why?

**Good:**
> The LSP completion isn't showing suggestions. Here's my frontend code:
> [completion handler code]
> Here's what I'm seeing in the browser console:
> [error message or absence thereof]
> I've verified:
> - LSP started (I see "rust-analyzer started" in the status bar)
> - The file is a .rs file
> - I'm typing in a valid context

### 4.5 Don't Expect Claude to Know Your Timeline

**Bad:**
> I need this done by Friday. Can you help me prioritize?

**Better:**
> I'm working on Phase 7 CRUD. Exit criteria: create/read/delete/rename all working. I've done create (~3 hours). Delete and rename are left. Based on your experience, which is riskier to defer to Phase 8?

Claude can reason about risk and complexity. It can't read your calendar.

---

## Part 5: Conversation Templates

Copy-paste these to start conversations efficiently.

### Template 1: Architecture Review (Pre-Code)

```
# Anvil — Architecture Review Request

## Current State
[paste ANVIL_STATE.md]

## What I'm Building
Phase [N], feature [X]: [description]

## Proposed Approach
1. [Plan A]
2. [Plan B]
3. [Data structures]
4. [Integration points]

## Concerns
- [Concern A]
- [Concern B]

## Relevant Files
[if any; usually not needed before coding]

## Question
Does this approach seem sound? Any gotchas or architectural debt I'm creating?
```

### Template 2: Code Review (Post-Implementation)

```
# Anvil — Code Review Request

## What I Implemented
Phase [N], feature [X]: [description]

## Exit Criteria Met?
- [ ] Criterion A
- [ ] Criterion B
- [etc.]

## Code
[paste the implementation]

## Questions for Review
1. Edge cases I'm missing?
2. Any panics/unwraps that are risky?
3. Architectural violations (see ANVIL_STATE.md)?
4. Performance concerns?
5. Testing gaps?

## Environment
- Rust version: [e.g., 1.77]
- OS: [e.g., macOS 14, Linux]
- Tauri version: 2.x
```

### Template 3: Bug Diagnosis

```
# Anvil — Bug Diagnosis Request

## Symptom
[What's happening]

## Expected
[What should happen]

## Reproduction Steps
1. [Step 1]
2. [Step 2]
3. [Step 3]

## What I've Verified
- [ ] Code compiles
- [ ] Function is being called (debug print confirms)
- [ ] Related functions work in isolation
- [ ] Not a config issue (I've checked [...])

## Relevant Code
[snippet showing the issue]

## Logs/Error Messages
[if any]

## Environment
- [OS, versions, etc.]
```

### Template 4: Decision Check

```
# Anvil — Locked Decision Check

## Current State
[paste ANVIL_PROJECT_TRACKER.md § 2 (Locked Decisions)]

## What I'm About to Build
[Description of feature]

## Question
Is there already a decision that affects this? Should I implement it differently based on locked decisions?
```

---

## Part 6: Workflow Checklist

Use this before starting a Claude conversation.

- [ ] **Have I pasted `ANVIL_STATE.md`?** (If starting fresh)
- [ ] **Is my question narrow and specific?** (Not "help me build Phase X")
- [ ] **Have I pasted only relevant files?** (Using Tier 1/2 from `CLAUDE_CONTEXT_FILES.md`)
- [ ] **Have I described what I've already tried?** (Especially for bugs)
- [ ] **Have I checked `ANVIL_PROJECT_TRACKER.md` for existing decisions?** (Searching for keywords)
- [ ] **If asking for design advice, have I sketched my proposal first?** (Don't ask Claude to design from scratch; ask if your design is sound)
- [ ] **If asking for code review, have I written the code myself?** (Don't ask Claude to write it)
- [ ] **Have I said what I'll do with the answer?** (Context helps Claude calibrate the response)

---

## Part 7: When NOT to Use Claude

These are situations where Claude's value is low or negative.

### 7.1 Debugging Compiler Errors

**Bad:** Paste a compiler error, ask Claude to fix it.

**Better:** Fix it yourself using the error message. Compiler errors are usually clear. You'll learn something.

**Exception:** If the error is cryptic (lifetime issues, trait errors), and you've spent 15+ minutes on it, then ask.

### 7.2 Decisions That Need Domain Knowledge Only You Have

**Bad:** "Should I use the trash crate or shell out to rm?"

Claude can list pros/cons, but you know your project's constraints (binary size, platform support, etc.). Make the call.

**Better:** "I'm choosing the trash crate because [your reasoning]. Does this create any issues downstream?" Claude reviews your reasoning.

### 7.3 Regex or Complex String Parsing

Claude is mediocre at these. You'll spend more time explaining the problem than fixing it yourself.

### 7.4 Bikeshedding Over Variable Names

Not worth Claude's time or your tokens.

---

## Part 8: Measuring Productivity Gains

How to tell if Claude conversations are helping or wasting time.

### Green Flags (Claude is Adding Value)

- ✅ Claude spotted a bug you would have found in testing (saved 30 min)
- ✅ Claude's architecture feedback changed your approach before you coded (saved refactor)
- ✅ You learned something about Rust/Tauri/LSP from Claude's explanation
- ✅ Claude's diff review caught an edge case (saved debugging)

### Red Flags (Claude Conversations are Wasting Time)

- ❌ You asked Claude something, then had to ask for clarification 3 times
- ❌ Claude gave generic advice that didn't apply to your project
- ❌ You're waiting for Claude to write code instead of writing it yourself
- ❌ You're debating architecture with Claude when you should just pick something
- ❌ The conversation went down a rabbit hole unrelated to your immediate task

**Fix:** Narrow the question, or switch to a different mode (code review instead of design).

---

## Part 9: Recording Insights for Future Reference

Every time Claude gives you a useful insight or spots a bug, record it.

### 9.1 Add to Gotchas Log

If Claude helps you diagnose a bug:

```
Symptom: [What happened]
Root cause: [What Claude/you discovered]
Fix: [What worked]
```

Append this to `ANVIL_PROJECT_TRACKER.md` § 8 (Gotchas Log). Future-you will search for this symptom.

### 9.2 Add to Locked Decisions

If Claude helps you settle a design question:

```
| Date | Decision | Rationale | Status |
| 2026-07-09 | [Decision made] | [Why, per Claude] | ✅ Locked |
```

Append to `ANVIL_PROJECT_TRACKER.md` § 2 (Locked Decisions).

### 9.3 Parked Ideas

If Claude suggests something that's not ready yet:

```
| Idea | Why not now | Revisit when |
| [Claude's suggestion] | [Reason to defer] | [Condition to revisit] |
```

Append to `ANVIL_PROJECT_TRACKER.md` § 6 (Parked Ideas).

---

## Part 10: Example Conversation Flow (From Real Phase 7 Work)

This is how the delete_path and rename_path discussion should have gone for maximum efficiency.

### Setup Message

```
# Anvil Phase 7 — Delete & Rename Commands

[paste ANVIL_STATE.md]

I'm adding `delete_path` and `rename_path` to Phase 7. Here's what I've already done:
- ✅ create_file command working
- ✅ create_folder command working
- ✅ Recent workspaces and no-workspace creation fallback working

## Delete Implementation Questions

I'm using the `trash` crate to send files to system trash (not permanent delete).

**Code snippet (preliminary):**
```rust
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("failed to trash {}: {}", path, e))
}
```

**Question:** If the user is viewing the deleted file in the editor, should I:
- Option A: Let the filesystem watcher trigger a reload (might fail if file no longer exists)
- Option B: Explicitly clear the editor if the opened file was deleted
- Option C: Both (clear immediately, *and* catch watcher errors gracefully)

## Rename Implementation Questions

Rename is trickier because of `.anvil/history/` snapshots. 

**Current pattern in history.rs:**
- Each file has a snapshot at `.anvil/history/{hash_of_original_path}/`
- If I rename `file.rs` to `renamed.rs`, the old snapshot path is stale

**Question:** Should `rename_path` command:
- Option A: Call `history::relocate_snapshot(old_path, new_path)` before the actual rename
- Option B: Clean up old snapshots in a separate pass (simpler, but leaves orphans)
- Option C: Trust the watcher to notice the old path is gone and clean it up

**My intuition:** Option A is safest but requires extending `history.rs`. Worth it?

## Before I Code

Does this approach seem sound? Should I tackle delete or rename first?
```

### Claude's Response (Idealized)

Claude would say something like:
```
Your approach is sound. Here's my feedback:

**Delete:** Use Option B (explicitly clear editor). Here's why:
- The watcher might be slow; users expect immediate UI feedback
- A failed file-not-found on the watcher is noise; better to be proactive
- You're already clearing currentFilePath in emptyState.js for other flows

**Rename:** Use Option A (relocate snapshot first). Here's why:
- Snapshots are your undo mechanism; losing them is worse than temporary orphans
- history::relocate_snapshot() is simple (just rename the .anvil/history/ directory)
- This respects "file on disk is truth" — the snapshot stays in sync with the file

**Order:** Do rename first (more complex, depends on getting snapshot relocation right). 
Delete is simpler and can ship first if timeline is tight.

**One gotcha:** If rename fails halfway (permissions, etc.), you might have a 
snapshot at the old path AND the file at the new path. Should you wrap both 
operations in a transaction, or document this as "if rename fails, manually 
move the file back"?
```

### Your Follow-Up

```
Good point on the rename transaction risk. I'll wrap it:

1. Snapshot the target (in case we need to revert the rename)
2. Move the .anvil/history/ directory
3. Rename the actual file on disk
4. If any step fails, roll back the snapshot move

Does this look right?

[sketch of logic]
```

### Claude Reviews Your Sketch

```
Looks good. One thing: what if the file *doesn't have* a snapshot yet 
(it's a fresh file, never saved)? Your step 1 will try to snapshot 
something that doesn't exist in history.rs. 

Should you:
- Gracefully skip snapshotting if no history exists, or
- Pre-check for it?

Also, does your `rollback` need to log what happened? Might be useful 
for debugging failed renames.
```

### You Code It Up

(Antigravity IDE or your editor)

### Final Review

```
I've implemented delete and rename. Here's the code:

[paste implementation]

Exit criteria met?
- ✅ Delete sends to trash, clears editor if current file was deleted
- ✅ Rename relocates snapshot, handles missing snapshots gracefully
- ✅ Errors propagate to UI as status messages
- ✅ Tested manually: delete and rename work on both files and folders

Can you spot any issues before I commit?
```

**Total conversation time: ~15 minutes.** You wrote all the code. Claude gave architecture guidance and caught edge cases. Result: high-quality implementation, your understanding intact, no tokens wasted on code-writing.

---

## Conclusion

Working with Claude effectively on Anvil is about:

1. **Respecting the token budget** — always paste `ANVIL_STATE.md` first, only relevant files after
2. **Asking narrow questions** — "How should I handle X?" beats "How should I build Phase Y?"
3. **Using Claude for design and review, not implementation** — you write code, Claude reviews it
4. **Recording decisions** — tracker prevents re-litigating the same question
5. **Learning from mistakes** — gotchas log and parked ideas are as valuable as working features

Follow this, and Claude conversations become a force multiplier. Skip it, and you'll spend tokens on noise and have code you don't fully understand.

Good luck. 🚀
