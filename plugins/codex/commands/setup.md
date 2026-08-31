---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate or automatic account switching
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-auto-account-switch|--disable-auto-account-switch] [--auto-switch-threshold <percent>]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Flags:
- `--enable-auto-account-switch` / `--disable-auto-account-switch`: toggle automatic Codex account switching (requires the `codex-auth` CLI; switches to the least-used stored account when the active one crosses the usage threshold or hits a usage-limit error).
- `--auto-switch-threshold <percent>`: usage percentage (1-100, default 95) at which the preflight check switches accounts.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
