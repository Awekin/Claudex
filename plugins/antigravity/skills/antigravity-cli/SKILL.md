---
name: antigravity-cli
description: How to delegate work to Antigravity models from Claude Code and how to choose the model (Gemini 4 Hydrogen/Argon, Flash, Claude Opus/Sonnet). Use when the user asks to send something to Antigravity/Gemini, or when a second model would help.
---

# Antigravity from Claude Code

Runs the official Antigravity CLI `agy` (install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in). The Antigravity app does not need to be open; when it is, the companion also reads model quota from it.

Companion: `node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" <command>`

| Command | Purpose |
|---|---|
| `models` | Models with remaining quota and their aliases |
| `task [--model A] [--background] [--fresh] [--no-context] [--read-only] "<task>"` | Run a task; agy edits files and runs commands in the git root of the current directory (read-only uses agy's plan mode) |
| `status [job-id]` | Jobs and live progress |
| `result [job-id]` | Result card |

Behaviour:
- Without `--fresh` a task continues this Claude session's agy conversation (`--conversation <id>`), so the model keeps its context.
- Recent Claude conversation is attached as context unless `--no-context`.
- `--read-only` runs agy in plan mode (no edits).
- If the chosen model has no quota, the companion picks the next one and says so in the card.

Choosing the model yourself (default `hydrogen`):
- quick question / tiny edit → `flash-low`
- normal task → `hydrogen`
- hard bug, multi-file change → `hydrogen-high`
- architecture, very hard or long task → `hydrogen-xhigh`
- second Gemini opinion or Hydrogen exhausted → `argon`
- Claude-family second opinion → `opus` (hard) / `sonnet` (normal); small quota

Quota: the first line of every result card shows the model's quota before → after the task.
Before `opus`, `sonnet` or `hydrogen-xhigh` (and before the first task of a session) run `models`;
below ~10% pick another model.

After a task that changed files, look at `git diff` before telling the user it is done.
