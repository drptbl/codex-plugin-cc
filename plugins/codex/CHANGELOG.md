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
