# Changelog

## 1.3.1 (2026-08-31) — broker lifecycle hardening after adversarial review

A multi-angle review of 1.3.0 found the self-cleanup interacting badly with the
restart path and with untrusted persisted state. All findings fixed:

- **Ownership established at creation, not inferred at delete**: broker session
  dirs now carry a sentinel file written by `createBrokerSessionDir`;
  `isBrokerOwnedSessionDir` checks the sentinel + `cxc-` naming instead of
  comparing against `os.tmpdir()`. This closes the 1.3.0 bypass where the
  broker recursively deleted an unvalidated `--session-dir` steered via
  persisted `broker.json` or `CODEX_COMPANION_APP_SERVER_ENDPOINT`, and it
  survives TMPDIR divergence between creator and reaper.
- **File cleanup only on self-initiated exits**: on `broker/shutdown` and
  SIGTERM/SIGINT the broker closes its runtime but leaves socket/pid/session
  dir to the requester's teardown — the dying broker can no longer race
  `restartBrokerSession` and delete the replacement broker's freshly-bound
  socket during an account switch.
- **Death signal fixed**: the broker exits on real `codex app-server` process
  death (`processExitPromise`), not on `exitPromise`, which also resolves on a
  single unparseable stdout line and would have killed a healthy pair mid-turn.
- **Fail-safe idle timeout**: only a literal `0` disables reaping; garbage
  values (`2h`, empty, `-1`) fall back to the 2h default with a logged warning
  (`parsePositiveInteger` also stopped accepting `parseInt`-style `"2h"` → 2).
- **Hardened exit machinery**: every exit path routes through one guarded
  `exitWith`; sockets are destroyed (a half-open peer can no longer wedge
  `server.close()` forever); file removal is force-tolerant.
- **No stale state after self-reap**: the broker clears the workspace
  `broker.json` (only while it still points at its own endpoint), so
  `reuseExistingBroker` callers stop dialing dead endpoints and misreporting
  auth/rate-limit state after an idle reap.
- **Failed restarts no longer leak** their `cxc-*` dir (the failure teardown
  now names the session dir, reclaimed under the ownership guard).
- **Test fixture**: the read-only contract check is keyed on the `--help`
  probe, not arg arity, so a future launch flag cannot silently skip it; env
  names come from the exported constants.
- Scope note: `--watch-pid` is an embedder/test facility with no producer in
  normal plugin use — in production the crash-path backstop is the idle
  timeout (plus the SessionEnd hook for clean exits).

## 1.3.0 (2026-08-31) — broker lifecycle: orphaned runtimes reap themselves

Born from a live leak: 58 orphaned broker + `codex app-server` process pairs
and 3,164 leftover `codex-plugin-test-*` temp dirs had accumulated under
`$TMPDIR`. The detached shared broker had no liveness tie to anything — only an
explicit `broker/shutdown` (the SessionEnd hook) ever ended it, so every path
that skipped the hook (the test suite, a crashed or killed session) leaked the
pair and its mkdtemp session dir forever.

- **Broker self-termination**: the broker now exits on its own when
  - the pid passed via `--watch-pid` dies (polled; interval configurable with
    `CODEX_COMPANION_BROKER_WATCH_INTERVAL_MS`),
  - its `codex app-server` child exits — a dead child previously left a zombie
    endpoint that `ensureBrokerSession` kept reusing, or
  - no client has been connected for `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS`
    (default 2 hours, `0` disables) — the crash-path backstop; the next
    invocation lazily respawns a broker, so an idle reap costs one cold start.
- **Session dir hygiene**: the broker receives its mkdtemp session dir via
  `--session-dir` and removes it (socket, pid file, log) on every exit path;
  `teardownBrokerSession` removes an explicitly recorded session dir
  recursively instead of only when already empty.
- **Test harness stops leaking**: `makeTempDir` removes everything it created
  when the test process exits, and the fake-codex fixture points every
  test-spawned broker's `--watch-pid` at the test process — brokers die with
  the run instead of outliving it. New regression tests cover all three broker
  exit paths.
- Fix: the test suite could not even load since 1.2.0 — an unescaped backtick
  in the fixture's embedded script broke the module parse, and the sandbox
  enforcement check tripped on the plugin's legitimate `app-server --help`
  availability probe. Both fixed; the full suite runs green again.

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
