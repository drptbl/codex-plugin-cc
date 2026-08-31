# Changelog

## 1.1.0 (fork)

- **Automatic account switching** (off by default): when `autoAccountSwitch` is
  enabled and the active ChatGPT account crosses the usage threshold (or a run
  fails with a usage-limit error), the plugin switches to the least-used account
  stored by `codex-auth`, restarts the shared Codex runtime on its existing
  endpoint, and retries once. New setup flags: `--enable-auto-account-switch`,
  `--disable-auto-account-switch`, `--auto-switch-threshold <percent>`. Requires
  `npm install -g @loongphy/codex-auth` and accounts registered by the user via
  `codex-auth login` / `codex-auth import`.
- **Review-only policy**: the sandbox is forced read-only at the plugin's single
  write surface — Codex reviews, diagnoses, and proposes patches; the host
  session applies edits itself. The rescue agent never passes `--write`.
- Fix: `restartBrokerSession` recreates the endpoint directory before respawn
  (teardown removes it once emptied) and never leaks a half-spawned broker.

## 1.0.0

- Initial version of the Codex plugin for Claude Code

## 1.2.0 (2026-08-31) — review-only enforced structurally, everywhere

Born from a live failure: stop-gate review jobs wrote repository files for a
whole evening despite the 1.1.0 per-thread read-only force — a user-level
`~/.codex/config.toml` `sandbox_mode = "danger-full-access"` silently won at
the app-server boundary.

- **Config-proof read-only**: the app-server child now launches with
  `-c sandbox_mode=read-only`, outranking any user config for every thread this
  plugin runs (per-thread `sandbox: "read-only"` stays as defense in depth).
  Review-only is the plugin's contract in EVERY repository, not a per-repo note.
- **Findings-not-edits prompt contract**: the stop-gate prompt now states the
  reviewer role explicitly — describe fixes in the BLOCK reason, never apply.
- **Stop-gate economics**: skip when the repository fingerprint (HEAD + dirty
  status) is unchanged since the last stop review; 10-minute cooldown between
  reviews — no more re-reviews of stale turns or duplicate work.
- **Visibility**: every stop-gate decision speaks on stderr — review starting
  (with repo, sandbox, budget), finished (duration + verdict), or why it was
  skipped. Background review work is never silent again.
- Gate default remains OFF per repository; `/codex:setup --enable-review-gate`
  opts a repo in, and setup output names the repo scope it changed.
