# Codex Plugin Automatic Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the active ChatGPT/Codex account exhausts its usage quota, the Claude Code codex plugin automatically switches to the second account (via the `codex-auth` CLI), restarts its Codex runtime, and continues — both proactively (preflight threshold check) and reactively (retry after a usage-limit error).

**Architecture:** We fork `openai/codex-plugin-cc` (this repo, Apache-2.0) and install the fork as a local directory marketplace, replacing the upstream `codex@openai-codex` plugin. We do **not** fork `codex-auth` (`@loongphy/codex-auth`, MIT, already installed globally as v0.2.10): its `--json` output is a stable versioned API (`schema_version: 1`) and it supports non-interactive switching by stable `account_key` — we shell out to it as an external binary. A new module `plugins/codex/scripts/lib/accounts.mjs` owns everything account-related: reading the codex-auth registry, classifying usage-limit errors, reading the active account's rate limits from the Codex app-server, choosing a fallback account, and orchestrating switch + runtime restart. The two work entry points in `codex.mjs` (`runAppServerTurn`, `runAppServerReview`) get a preflight check and a single-attempt failover retry.

**Tech Stack:** Node.js ≥ 18.18 plain ESM (no TypeScript in scripts), `node:test` + `node:assert/strict`, `codex-auth` 0.2.10 as an external binary, Codex app-server JSON-RPC (`account/rateLimits/read`).

## Why these decisions (research summary)

- **The plugin never reads `~/.codex/auth.json`** — it talks to `codex app-server` over JSON-RPC (`plugins/codex/scripts/lib/app-server.mjs`). The long-lived shared runtime (the broker, `plugins/codex/scripts/app-server-broker.mjs`) holds auth tokens **in memory**, so swapping `auth.json` on disk has no effect on it until the broker process is restarted. This is why codex-auth's own background auto-switch service (`codex-auth config auto enable`) is NOT enough: it would swap credentials invisibly under a live broker. Our switch happens at plugin-controlled boundaries with an explicit broker restart.
- **We always call codex-auth with `--skip-api`.** codex-auth's live mode polls `https://chatgpt.com/backend-api/wham/usage`, and its own help warns that enabling API polling "may trigger OpenAI account restrictions or suspension in some environments." The active account's usage comes instead from Codex's own official channel — the app-server request `account/rateLimits/read` (present in codex-cli 0.150.1). The fallback account's usage comes from codex-auth's cached registry (`last_usage` in `~/.codex/accounts/registry.json`).
- **Usage-limit vocabulary in codex-cli 0.150.1 binary:** `rate_limit_reached`, `usage_limit_reached`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`, `workspace_owner_credits_depleted`. Today the plugin throws these away: `codex.mjs:537` (`case "error":`) stores `message.params.error` unread, and `buildResultStatus` (`codex.mjs:754`) collapses everything to exit 0/1.
- **The installed plugin cache copy** (`~/.claude/plugins/cache/openai-codex/codex/1.0.6`) is refcounted and swept — editing it in place is not durable. The fork lives at `/Users/jakubmucha/repos/codex-plugin-cc` and is installed via a local **directory marketplace** (same mechanism as the existing `synpress` marketplace at `/Users/jakubmucha/repos/synpress-qa`).
- **Everything defaults off** (`autoAccountSwitch: false`); it is enabled per-repo via `/codex:setup --enable-auto-account-switch`, mirroring the existing `stopReviewGate` config pattern.

## Amendment (2026-08-29, after Task 2)

Task 2's live capture disproved two research assumptions, and Tasks 3/6/7 were rewritten accordingly. Governing facts:

1. **The installed `codex-auth` 0.2.10 (npm `latest`) has no `--json` flag** — the JSON API exists only in `0.3.0-alpha.*` pre-releases, which we will not depend on for an auth-critical path. Account data is instead read **directly from `${CODEX_HOME:-~/.codex}/accounts/registry.json`** (real structure captured in `tests/fixtures/codex-auth-list.json`); an account is active iff its `account_key` equals the registry's top-level `active_account_key`. `codex-auth` is still used for switching: `codex-auth switch <email>` is non-interactive in 0.2.10, and success is verified by re-reading the registry, not by exit code alone.
2. **The registry cache's `last_usage.primary.used_percent` has unreliable semantics** (observed values were the complement of live usage — it may store *remaining* percent — and `secondary` was `null` for both accounts). Therefore cached usage is used ONLY to order fallback candidates, NEVER to refuse a switch: `pickFallbackAccount(registry)` takes no threshold and returns null only when no non-active account exists. The threshold applies solely to the preflight check of the ACTIVE account, whose usage comes from the authoritative app-server response (`rateLimits.primary.usedPercent`, camelCase, `secondary` nullable — see `tests/fixtures/rate-limits-read.json`).

## Global Constraints

- Node ≥ 18.18.0, plain ESM `.mjs`, two-space indent — match existing `plugins/codex/scripts/lib/*` style.
- **No new npm dependencies.** `codex-auth` is invoked as an external binary via `node:child_process`.
- Test runner: `node --test`. This machine's Claude session exports plugin env vars that break 4 tests, so ALWAYS run tests as:
  `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_APP_SERVER_ENDPOINT -u CODEX_COMPANION_APP_SERVER_PID_FILE -u CODEX_COMPANION_APP_SERVER_LOG_FILE node --test tests/*.test.mjs`
  (referred to below as `$TEST_ENV node --test …`; baseline on `db52e28` is 91/91 pass with this prefix).
- No secrets in fixtures or commits: redact emails to `account-a@example.com` / `account-b@example.com`, account keys to `acct-key-a` / `acct-key-b`, never commit tokens.
- Keep `LICENSE` and `NOTICE` intact (Apache-2.0 fork obligations).
- New config keys: `autoAccountSwitch` (boolean, default `false`), `autoAccountSwitchThresholdPercent` (number, default `95`). Single source of truth: `defaultState()` in `plugins/codex/scripts/lib/state.mjs`.
- At most **one** failover attempt per run (no switch loops).
- Working dir for all tasks: `/Users/jakubmucha/repos/codex-plugin-cc`, branch `feature/auto-account-switch`.
- Import direction (no cycles): `codex.mjs` → `accounts.mjs` → {`app-server.mjs`, `broker-lifecycle.mjs`, `state.mjs`, `process.mjs`}. `broker-lifecycle.mjs` must never import `app-server.mjs`.

---

### Task 1: Branch, baseline, and plan commit

**Files:**
- Create: `docs/superpowers/plans/2026-08-29-auto-account-switch.md` (this file, already written)

**Interfaces:**
- Produces: branch `feature/auto-account-switch` with a green 91-test baseline that all later tasks build on.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/jakubmucha/repos/codex-plugin-cc
git checkout -b feature/auto-account-switch
```

- [ ] **Step 2: Verify the baseline is green**

Run:
```bash
env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_APP_SERVER_ENDPOINT -u CODEX_COMPANION_APP_SERVER_PID_FILE -u CODEX_COMPANION_APP_SERVER_LOG_FILE node --test tests/*.test.mjs 2>&1 | tail -12
```
Expected: `# pass 91`, `# fail 0`, exit code 0. If not, STOP — do not build on a red baseline.

- [ ] **Step 3: Commit the plan document**

```bash
git add docs/superpowers/plans/2026-08-29-auto-account-switch.md
git commit -m "docs: add auto account switching implementation plan"
```

---

### Task 2: Capture real JSON fixtures (codex-auth list, account/rateLimits/read)

Later tasks parse two JSON shapes whose exact field spelling we must confirm against reality, not docs. Capture both now, redact, and commit as test fixtures.

**Files:**
- Create: `tests/fixtures/codex-auth-list.json`
- Create: `tests/fixtures/rate-limits-read.json`

**Interfaces:**
- Produces: fixture files that Task 3's parser tests and Task 4's normalizer tests import. Task 3/4 code MUST be adjusted to the actual key spelling found here if it differs from the code shown in those tasks (docs say accounts carry a usage snapshot with `primary.used_percent`, `secondary`, `source`; the registry file on disk uses `last_usage` — the fixture decides).

- [ ] **Step 1: Capture codex-auth list output**

```bash
mkdir -p tests/fixtures
codex-auth list --json --skip-api > /tmp/codex-auth-list.raw.json
cat /tmp/codex-auth-list.raw.json
```
Expected: JSON with `"schema_version": 1`, `"command": "list"`, `"active_account_key"`, and an `"accounts"` array with 2 entries carrying per-account usage percentages.

- [ ] **Step 2: Write the redacted fixture**

Copy `/tmp/codex-auth-list.raw.json` to `tests/fixtures/codex-auth-list.json` **preserving every key and the exact nesting**, replacing only values:
- emails → `account-a@example.com` (the low-usage account) and `account-b@example.com` (the high-usage, currently-active account)
- account keys → `acct-key-a` / `acct-key-b`; `active_account_key` → `acct-key-b`
- aliases/account names → `null`
- set account-a's 5h/weekly used percents to `6`/`6` and account-b's to `99`/`99` (mirrors the real situation; keeps tests meaningful)
- timestamps may stay as-is (they are not secrets)

- [ ] **Step 3: Capture the app-server rate-limits response**

Write `/tmp/probe-rate-limits.mjs`:
```js
import { CodexAppServerClient } from "/Users/jakubmucha/repos/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs";

const client = await CodexAppServerClient.connect(process.cwd(), { disableBroker: true });
try {
  const response = await client.request("account/rateLimits/read", {});
  console.log(JSON.stringify(response, null, 2));
} finally {
  await client.close();
}
```
Run:
```bash
env -u CODEX_COMPANION_APP_SERVER_ENDPOINT node /tmp/probe-rate-limits.mjs
```
Expected: a JSON document containing rate-limit windows with used-percent numbers (vocabulary in the binary suggests fields like `rate_limit_remaining_percent` / `rate_limit_resets` or a `rateLimits.primary/secondary` shape).
Contingency: if the request fails with rpcCode `-32601` (method not found), record the error text in the fixture as `{"unsupported": true, "error": "<text>"}` — Task 4's normalizer already returns nulls for unrecognized shapes, and the preflight then relies on registry data only.

- [ ] **Step 4: Write the redacted rate-limits fixture**

Copy the output to `tests/fixtures/rate-limits-read.json`, preserving all keys; redact any account id/email values the same way as Step 2. Keep the real percent numbers.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/codex-auth-list.json tests/fixtures/rate-limits-read.json
git commit -m "test: add redacted codex-auth and rate-limits fixtures"
```

---

### Task 3: accounts.mjs — codex-auth registry adapter (TDD)

**Files:**
- Create: `plugins/codex/scripts/lib/accounts.mjs`
- Test: `tests/accounts.test.mjs`

**Interfaces:**
- Consumes: `binaryAvailable` from `plugins/codex/scripts/lib/process.mjs`; fixture `tests/fixtures/codex-auth-list.json` (a redacted copy of a real `~/.codex/accounts/registry.json`).
- Produces (used by Tasks 4/6/7):
  - `readAccountRegistry({ registryPath? }) → { available: boolean, detail: string|null, activeAccountKey: string|null, accounts: Array<{ accountKey, email, alias, active, plan, primaryUsedPercent, secondaryUsedPercent }> }` — reads the registry FILE directly (default path `${CODEX_HOME:-~/.codex}/accounts/registry.json`); `active` is derived from `account_key === active_account_key`; usage comes from `last_usage.primary/secondary.used_percent` with `secondary` frequently `null`.
  - `pickFallbackAccount(registry) → account|null` — least-cached-used non-active account; NO threshold parameter (see Amendment); null only when no non-active account exists.
  - `switchActiveAccount(target, { runCommand?, registryPath? }) → { switched: boolean, detail: string }` where `target = { email, accountKey }` — runs `codex-auth switch <email>` and verifies success by re-reading the registry and checking `activeAccountKey === target.accountKey`.
  - `getCodexAuthAvailability() → { available: boolean, detail: string }` — checks the `codex-auth` binary (needed for switching only; reading needs just the file).
  - internal default `runCodexAuth(args)` using `spawnSync`.

- [ ] **Step 1: Write the failing tests**

Create `tests/accounts.test.mjs`:
```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  pickFallbackAccount,
  readAccountRegistry,
  switchActiveAccount
} from "../plugins/codex/scripts/lib/accounts.mjs";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const REGISTRY_FIXTURE_PATH = path.join(FIXTURES_DIR, "codex-auth-list.json");

function writeRegistry(mutate) {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FIXTURE_PATH, "utf8"));
  mutate?.(registry);
  const registryPath = path.join(makeTempDir(), "registry.json");
  fs.writeFileSync(registryPath, JSON.stringify(registry), "utf8");
  return registryPath;
}

test("readAccountRegistry parses the on-disk registry and derives the active flag", () => {
  const registry = readAccountRegistry({ registryPath: REGISTRY_FIXTURE_PATH });

  assert.equal(registry.available, true);
  assert.equal(registry.activeAccountKey, "acct-key-b");
  assert.equal(registry.accounts.length, 2);

  const active = registry.accounts.find((account) => account.active);
  assert.equal(active.accountKey, "acct-key-b");
  assert.equal(active.email, "account-b@example.com");
  assert.equal(active.primaryUsedPercent, 99);

  const idle = registry.accounts.find((account) => !account.active);
  assert.equal(idle.accountKey, "acct-key-a");
  assert.equal(idle.primaryUsedPercent, 6);
});

test("readAccountRegistry reports unavailable when the registry file is missing", () => {
  const registry = readAccountRegistry({
    registryPath: path.join(makeTempDir(), "missing", "registry.json")
  });
  assert.equal(registry.available, false);
  assert.equal(registry.accounts.length, 0);
});

test("readAccountRegistry reports unavailable on unparsable registry content", () => {
  const registryPath = path.join(makeTempDir(), "registry.json");
  fs.writeFileSync(registryPath, "not json", "utf8");
  const registry = readAccountRegistry({ registryPath });
  assert.equal(registry.available, false);
});

test("pickFallbackAccount returns the least-cached-used inactive account", () => {
  const registry = readAccountRegistry({ registryPath: REGISTRY_FIXTURE_PATH });
  const fallback = pickFallbackAccount(registry);
  assert.equal(fallback.accountKey, "acct-key-a");
});

test("pickFallbackAccount returns null when no inactive account exists", () => {
  const registryPath = writeRegistry((registry) => {
    registry.accounts = registry.accounts.filter(
      (account) => account.account_key === "acct-key-b"
    );
  });
  const fallback = pickFallbackAccount(readAccountRegistry({ registryPath }));
  assert.equal(fallback, null);
});

test("pickFallbackAccount tolerates accounts with no cached usage", () => {
  const registryPath = writeRegistry((registry) => {
    for (const account of registry.accounts) {
      if (account.account_key === "acct-key-a") {
        account.last_usage = null;
      }
    }
  });
  const fallback = pickFallbackAccount(readAccountRegistry({ registryPath }));
  assert.equal(fallback.accountKey, "acct-key-a");
});

test("switchActiveAccount runs codex-auth switch by email and verifies via the registry", () => {
  // Simulate the post-switch world: registry already shows acct-key-a active.
  const registryPath = writeRegistry((registry) => {
    registry.active_account_key = "acct-key-a";
  });
  const calls = [];
  const result = switchActiveAccount(
    { email: "account-a@example.com", accountKey: "acct-key-a" },
    {
      registryPath,
      runCommand: (args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      }
    }
  );
  assert.equal(result.switched, true);
  assert.deepEqual(calls, [["switch", "account-a@example.com"]]);
});

test("switchActiveAccount reports failure on non-zero exit", () => {
  const result = switchActiveAccount(
    { email: "account-a@example.com", accountKey: "acct-key-a" },
    {
      registryPath: REGISTRY_FIXTURE_PATH,
      runCommand: () => ({ status: 1, stdout: "", stderr: "no matching account" })
    }
  );
  assert.equal(result.switched, false);
  assert.match(result.detail, /no matching account/);
});

test("switchActiveAccount fails when the registry does not confirm the switch", () => {
  // Registry still shows acct-key-b active even though the command exited 0.
  const result = switchActiveAccount(
    { email: "account-a@example.com", accountKey: "acct-key-a" },
    {
      registryPath: REGISTRY_FIXTURE_PATH,
      runCommand: () => ({ status: 0, stdout: "", stderr: "" })
    }
  );
  assert.equal(result.switched, false);
  assert.match(result.detail, /verification/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$TEST_ENV node --test tests/accounts.test.mjs`
Expected: FAIL — `Cannot find module .../accounts.mjs`.

- [ ] **Step 3: Implement the adapter**

Create `plugins/codex/scripts/lib/accounts.mjs`:
```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { binaryAvailable } from "./process.mjs";

const CODEX_AUTH_BINARY = "codex-auth";

export function getCodexAuthAvailability() {
  return binaryAvailable(CODEX_AUTH_BINARY, ["--version"]);
}

function resolveRegistryPath() {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  return path.join(codexHome, "accounts", "registry.json");
}

function runCodexAuth(args) {
  const result = spawnSync(CODEX_AUTH_BINARY, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function usedPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeAccount(raw, activeAccountKey) {
  const usage = raw.last_usage ?? null;
  return {
    accountKey: raw.account_key ?? null,
    email: raw.email ?? null,
    alias: raw.alias ?? null,
    active: raw.account_key != null && raw.account_key === activeAccountKey,
    plan: raw.plan ?? null,
    primaryUsedPercent: usedPercent(usage?.primary?.used_percent),
    secondaryUsedPercent: usedPercent(usage?.secondary?.used_percent)
  };
}

export function readAccountRegistry(options = {}) {
  const registryPath = options.registryPath ?? resolveRegistryPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (error) {
    return {
      available: false,
      detail: `Cannot read codex-auth registry at ${registryPath}: ${error.message}`,
      activeAccountKey: null,
      accounts: []
    };
  }

  if (!Array.isArray(parsed.accounts)) {
    return {
      available: false,
      detail: `codex-auth registry at ${registryPath} has no accounts array`,
      activeAccountKey: null,
      accounts: []
    };
  }

  const activeAccountKey = parsed.active_account_key ?? null;
  return {
    available: true,
    detail: null,
    activeAccountKey,
    accounts: parsed.accounts.map((raw) => normalizeAccount(raw, activeAccountKey))
  };
}

function worstUsedPercent(account) {
  return Math.max(account.primaryUsedPercent ?? 0, account.secondaryUsedPercent ?? 0);
}

export function pickFallbackAccount(registry) {
  // Cached registry usage has unreliable semantics (observed storing what
  // looks like REMAINING percent in some versions), so it only orders the
  // candidates; it never disqualifies one. The single failover attempt is
  // the real guard against switching to an exhausted account.
  const candidates = registry.accounts
    .filter((account) => !account.active && account.accountKey && account.email)
    .sort((left, right) => worstUsedPercent(left) - worstUsedPercent(right));
  return candidates[0] ?? null;
}

export function switchActiveAccount(target, options = {}) {
  const runCommand = options.runCommand ?? runCodexAuth;
  const result = runCommand(["switch", target.email]);

  if (result.status !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()) || "codex-auth switch failed";
    return { switched: false, detail };
  }

  const registry = readAccountRegistry(options);
  if (!registry.available || registry.activeAccountKey !== target.accountKey) {
    return {
      switched: false,
      detail: `codex-auth switch ran but registry verification failed: ${target.email} is not the active account.`
    };
  }

  return { switched: true, detail: `Switched active Codex account to ${target.email}.` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$TEST_ENV node --test tests/accounts.test.mjs`
Expected: PASS (9 tests). Then run the full suite: `$TEST_ENV node --test tests/*.test.mjs` — expect 100 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/accounts.mjs tests/accounts.test.mjs
git commit -m "feat: add codex-auth registry adapter"
```

---

### Task 4: Usage-limit error classification and rate-limit normalization (TDD)

**Files:**
- Modify: `plugins/codex/scripts/lib/accounts.mjs` (append)
- Test: `tests/accounts.test.mjs` (append)

**Interfaces:**
- Consumes: fixture `tests/fixtures/rate-limits-read.json`; `CodexAppServerClient` from `plugins/codex/scripts/lib/app-server.mjs`.
- Produces (used by Tasks 7/8):
  - `isUsageLimitError(error) → boolean` — classifies the `message.params.error` object that `codex.mjs:537-539` currently stores unread.
  - `normalizeRateLimits(response) → { primaryUsedPercent: number|null, secondaryUsedPercent: number|null }`
  - `readActiveRateLimits(cwd) → Promise<{ primaryUsedPercent, secondaryUsedPercent }>` — connects with `reuseExistingBroker: true`, requests `account/rateLimits/read`, closes; returns nulls on any failure.

- [ ] **Step 1: Write the failing tests (append to `tests/accounts.test.mjs`)**

```js
import {
  isUsageLimitError,
  normalizeRateLimits
} from "../plugins/codex/scripts/lib/accounts.mjs";

const RATE_LIMITS_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "rate-limits-read.json"), "utf8")
);

test("isUsageLimitError matches known codex usage-limit codes", () => {
  for (const code of [
    "rate_limit_reached",
    "usage_limit_reached",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
    "workspace_owner_credits_depleted"
  ]) {
    assert.equal(isUsageLimitError({ code, message: "x" }), true, code);
    assert.equal(isUsageLimitError({ type: code, message: "x" }), true, `type:${code}`);
  }
});

test("isUsageLimitError matches limit phrasing in the message text", () => {
  assert.equal(isUsageLimitError({ message: "You've hit your usage limit." }), true);
  assert.equal(isUsageLimitError({ message: "Rate limit reached for this account" }), true);
});

test("isUsageLimitError rejects unrelated errors", () => {
  assert.equal(isUsageLimitError(null), false);
  assert.equal(isUsageLimitError({ message: "stream disconnected" }), false);
  assert.equal(isUsageLimitError({ code: "sandbox_denied", message: "denied" }), false);
});

test("normalizeRateLimits extracts used percents from the recorded fixture", () => {
  const limits = normalizeRateLimits(RATE_LIMITS_FIXTURE);
  // The fixture was captured live in Task 2; at least one window must yield a number
  // unless the fixture recorded {"unsupported": true}.
  if (!RATE_LIMITS_FIXTURE.unsupported) {
    assert.equal(typeof limits.primaryUsedPercent, "number");
  }
  assert.equal(Object.hasOwn(limits, "secondaryUsedPercent"), true);
});

test("normalizeRateLimits returns nulls for unknown shapes", () => {
  assert.deepEqual(normalizeRateLimits({ unexpected: true }), {
    primaryUsedPercent: null,
    secondaryUsedPercent: null
  });
  assert.deepEqual(normalizeRateLimits(null), {
    primaryUsedPercent: null,
    secondaryUsedPercent: null
  });
});
```
Merge the new imports into the existing import block at the top of the file (single import statement per module).

- [ ] **Step 2: Run tests to verify they fail**

Run: `$TEST_ENV node --test tests/accounts.test.mjs`
Expected: FAIL — `isUsageLimitError` / `normalizeRateLimits` not exported.

- [ ] **Step 3: Implement (append to `plugins/codex/scripts/lib/accounts.mjs`)**

Add to the imports: `import { CodexAppServerClient } from "./app-server.mjs";`

```js
const USAGE_LIMIT_CODES = new Set([
  "rate_limit_reached",
  "usage_limit_reached",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
  "workspace_owner_credits_depleted"
]);

const USAGE_LIMIT_MESSAGE_PATTERN =
  /(rate limit|usage limit|weekly limit)s? (reached|exceeded|hit)|hit your usage limit|out of (usage|credits)/i;

export function isUsageLimitError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const codes = [error.code, error.type, error.data?.type, error.data?.code]
    .filter((value) => typeof value === "string");
  if (codes.some((value) => USAGE_LIMIT_CODES.has(value))) {
    return true;
  }
  return USAGE_LIMIT_MESSAGE_PATTERN.test(String(error.message ?? ""));
}

function windowUsedPercent(window) {
  const used = window?.used_percent ?? window?.usedPercent ?? null;
  if (typeof used === "number" && Number.isFinite(used)) {
    return used;
  }
  const remaining = window?.remaining_percent ?? window?.remainingPercent ?? null;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    return 100 - remaining;
  }
  return null;
}

export function normalizeRateLimits(response) {
  const container = response?.rateLimits ?? response?.rate_limits ?? response ?? {};
  return {
    primaryUsedPercent: windowUsedPercent(container.primary),
    secondaryUsedPercent: windowUsedPercent(container.secondary)
  };
}

export async function readActiveRateLimits(cwd) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    const response = await client.request("account/rateLimits/read", {});
    return normalizeRateLimits(response);
  } catch {
    return { primaryUsedPercent: null, secondaryUsedPercent: null };
  } finally {
    await client?.close().catch(() => {});
  }
}
```
**Adjust `windowUsedPercent`/`normalizeRateLimits` container paths to match the Task 2 fixture** if the live response nests differently — the fixture-driven test is the contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `$TEST_ENV node --test tests/accounts.test.mjs` — expect PASS (14 tests). Full suite: `$TEST_ENV node --test tests/*.test.mjs` — expect 105 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/accounts.mjs tests/accounts.test.mjs
git commit -m "feat: classify usage-limit errors and read app-server rate limits"
```

---

### Task 5: restartBrokerSession in broker-lifecycle.mjs (TDD)

The shared runtime holds old-account tokens in memory. This task adds the one primitive that makes a mid-session switch real: kill the broker and respawn it **on the same endpoint path**, so the Claude session's exported `CODEX_COMPANION_APP_SERVER_ENDPOINT` stays valid and the shared runtime survives the switch. If respawn fails, callers degrade gracefully: `withAppServer` (`codex.mjs:613-642`) already retries direct on `ECONNREFUSED`/`ENOENT`, and each direct spawn reads `auth.json` fresh.

**Files:**
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs`
- Test: `tests/broker-restart.test.mjs`

**Interfaces:**
- Consumes: existing `loadBrokerSession`, `saveBrokerSession`, `clearBrokerSession`, `teardownBrokerSession`, `spawnBrokerProcess`, `waitForBrokerEndpoint`, `sendBrokerShutdown`, `PID_FILE_ENV`, `LOG_FILE_ENV` (all already in `broker-lifecycle.mjs`); `terminateProcessTree` from `./process.mjs`.
- Produces (used by Task 7): `restartBrokerSession(cwd, { endpoint?, env?, killProcess?, spawnProcess?, timeoutMs?, scriptPath? }) → Promise<session|null>` — `null` means "no broker to restart or respawn failed; direct transport takes over". NOTE: the endpoint env var name lives in `app-server.mjs` (`BROKER_ENDPOINT_ENV`); to avoid an import cycle, callers pass `endpoint` in — `restartBrokerSession` itself never reads `BROKER_ENDPOINT_ENV`.

- [ ] **Step 1: Write the failing test**

Create `tests/broker-restart.test.mjs`:
```js
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadBrokerSession,
  restartBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function listenOnSocket(socketPath) {
  return new Promise((resolve) => {
    const server = net.createServer(() => {});
    server.listen(socketPath, () => resolve(server));
  });
}

test("restartBrokerSession returns null when there is no broker", async () => {
  const workspace = makeTempDir();
  const result = await restartBrokerSession(workspace, { env: {} });
  assert.equal(result, null);
});

test("restartBrokerSession kills the old broker and respawns on the same endpoint", async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir();
  const endpoint = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "12345\n", "utf8");
  saveBrokerSession(workspace, { endpoint, pidFile, logFile, sessionDir, pid: 12345 });

  const killed = [];
  let respawnServer = null;
  t.after(() => respawnServer?.close());

  const session = await restartBrokerSession(workspace, {
    env: {},
    killProcess: (pid) => killed.push(pid),
    spawnProcess: (options) => {
      // Simulate the new broker binding the same socket path.
      assert.equal(options.endpoint, endpoint);
      return {
        pid: 67890,
        bind: (listenOnSocket(options.endpoint).then((server) => {
          respawnServer = server;
        }))
      };
    },
    timeoutMs: 3000
  });

  assert.notEqual(session, null);
  assert.equal(session.endpoint, endpoint);
  assert.equal(session.pid, 67890);
  assert.deepEqual(killed, [12345]);
  assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint);
});
```
(The `CLAUDE_PLUGIN_DATA`-aware `makeTempDir` helper already exists in `tests/helpers.mjs`; run with the `$TEST_ENV` prefix like every other test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `$TEST_ENV node --test tests/broker-restart.test.mjs`
Expected: FAIL — `restartBrokerSession` is not exported.

- [ ] **Step 3: Implement `restartBrokerSession`**

Append to `plugins/codex/scripts/lib/broker-lifecycle.mjs` (it already imports `fs`, `path`, `process`, `fileURLToPath`; add `import { terminateProcessTree } from "./process.mjs";` at the top):
```js
export async function restartBrokerSession(cwd, options = {}) {
  const env = options.env ?? process.env;
  const existing = loadBrokerSession(cwd);
  const endpoint = options.endpoint ?? existing?.endpoint ?? null;
  if (!endpoint) {
    return null;
  }

  const pidFile = existing?.pidFile ?? env[PID_FILE_ENV] ?? path.join(path.dirname(endpoint), "broker.pid");
  const logFile = existing?.logFile ?? env[LOG_FILE_ENV] ?? path.join(path.dirname(endpoint), "broker.log");
  const sessionDir = existing?.sessionDir ?? path.dirname(endpoint);
  const pid = existing?.pid ?? null;

  await sendBrokerShutdown(endpoint).catch(() => {});
  teardownBrokerSession({
    endpoint,
    pidFile,
    logFile,
    sessionDir: null,
    pid,
    killProcess: options.killProcess ?? terminateProcessTree
  });
  clearBrokerSession(cwd);

  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    fs.rmSync(endpoint, { force: true });
  }

  const scriptPath =
    options.scriptPath ?? fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const spawnProcess = options.spawnProcess ?? spawnBrokerProcess;
  const child = spawnProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 5000);
  if (!ready) {
    return null;
  }

  const session = { endpoint, pidFile, logFile, sessionDir, pid: child.pid ?? null };
  saveBrokerSession(cwd, session);
  return session;
}
```
Note `sessionDir: null` in the teardown call: `teardownBrokerSession` deletes the session dir when given one, and we are about to reuse the same socket path inside it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `$TEST_ENV node --test tests/broker-restart.test.mjs` — expect PASS (2 tests). Full suite: `$TEST_ENV node --test tests/*.test.mjs` — expect 107 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/broker-lifecycle.mjs tests/broker-restart.test.mjs
git commit -m "feat: restart the shared broker on its existing endpoint"
```

---### Task 6: Config keys, setup flags, and setup report

**Files:**
- Modify: `plugins/codex/scripts/lib/state.mjs:19-27` (`defaultState`)
- Modify: `plugins/codex/scripts/codex-companion.mjs:182-239` (`buildSetupReport`, `handleSetup`)
- Modify: `plugins/codex/scripts/lib/render.mjs:177-209` (`renderSetupReport`)
- Modify: `plugins/codex/commands/setup.md` (document the new flags)
- Test: `tests/state.test.mjs` (append), `tests/render.test.mjs` (append)

**Interfaces:**
- Consumes: `readAccountRegistry`, `getCodexAuthAvailability` from `accounts.mjs` (Task 3); `getConfig`/`setConfig` from `state.mjs`.
- Produces: config keys `autoAccountSwitch` / `autoAccountSwitchThresholdPercent` (read by Task 7); setup report field `accountSwitching: { enabled, thresholdPercent, codexAuth: {available, detail}, accounts: [{email, alias, active, primaryUsedPercent, secondaryUsedPercent}] }`; CLI flags `--enable-auto-account-switch`, `--disable-auto-account-switch`, `--auto-switch-threshold <percent>`.

- [ ] **Step 1: Write the failing config-default test (append to `tests/state.test.mjs`)**

```js
import { loadState } from "../plugins/codex/scripts/lib/state.mjs";

test("default config carries auto account switch keys", () => {
  const workspace = makeTempDir();
  const state = loadState(workspace);
  assert.equal(state.config.autoAccountSwitch, false);
  assert.equal(state.config.autoAccountSwitchThresholdPercent, 95);
});
```
(Merge `loadState` into the existing import from `state.mjs`; `makeTempDir` is already imported.)

- [ ] **Step 2: Run, verify it fails**

Run: `$TEST_ENV node --test tests/state.test.mjs` — expect FAIL (`autoAccountSwitch` undefined).

- [ ] **Step 3: Add the defaults**

In `plugins/codex/scripts/lib/state.mjs`, change `defaultState()`:
```js
function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      autoAccountSwitch: false,
      autoAccountSwitchThresholdPercent: 95
    },
    jobs: []
  };
}
```
Run: `$TEST_ENV node --test tests/state.test.mjs` — expect PASS.

- [ ] **Step 4: Write the failing render test (append to `tests/render.test.mjs`)**

Look at the top of `tests/render.test.mjs` for how existing tests build a report object and call `renderSetupReport`; add:
```js
test("renderSetupReport prints the account switching section when present", () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: "v24" },
    npm: { detail: "12" },
    codex: { detail: "codex-cli 0.150.1" },
    auth: { detail: "ChatGPT login active for account-b@example.com" },
    sessionRuntime: { label: "shared session" },
    reviewGateEnabled: false,
    accountSwitching: {
      enabled: true,
      thresholdPercent: 95,
      codexAuth: { available: true, detail: "codex-auth 0.2.10" },
      accounts: [
        { email: "account-b@example.com", alias: null, active: true, primaryUsedPercent: 99, secondaryUsedPercent: 99 },
        { email: "account-a@example.com", alias: null, active: false, primaryUsedPercent: 6, secondaryUsedPercent: 6 }
      ]
    },
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /auto account switch: enabled \(threshold 95%\)/);
  assert.match(output, /\* account-b@example\.com — 5h 99%, weekly 99%/);
  assert.match(output, /  account-a@example\.com — 5h 6%, weekly 6%/);
});
```
(Reuse the existing import of `renderSetupReport` if present; otherwise add it.)

- [ ] **Step 5: Run, verify it fails; implement the renderer**

Run: `$TEST_ENV node --test tests/render.test.mjs` — expect FAIL.

In `plugins/codex/scripts/lib/render.mjs`, inside `renderSetupReport`, after the `- review gate: …` line (line 189) insert:
```js
  if (report.accountSwitching) {
    const section = report.accountSwitching;
    const summary = section.enabled
      ? `enabled (threshold ${section.thresholdPercent}%)`
      : "disabled";
    lines.push(`- auto account switch: ${summary}`);
    if (!section.codexAuth.available) {
      lines.push(`  codex-auth unavailable: ${section.codexAuth.detail}`);
    }
    for (const account of section.accounts) {
      const marker = account.active ? "*" : " ";
      const name = account.alias ?? account.email ?? "unknown account";
      const primary = account.primaryUsedPercent ?? "?";
      const secondary = account.secondaryUsedPercent ?? "?";
      lines.push(`  ${marker} ${name} — 5h ${primary}%, weekly ${secondary}%`);
    }
  }
```
Run: `$TEST_ENV node --test tests/render.test.mjs` — expect PASS.

- [ ] **Step 6: Wire flags and report into codex-companion.mjs**

In `plugins/codex/scripts/codex-companion.mjs`:

1. Add to the imports from `./lib/accounts.mjs` (new import line near the other `./lib/` imports):
```js
import { getCodexAuthAvailability, readAccountRegistry } from "./lib/accounts.mjs";
```
2. In `handleSetup` (line 215), extend the option parsing:
```js
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "auto-switch-threshold"],
    booleanOptions: [
      "json",
      "enable-review-gate",
      "disable-review-gate",
      "enable-auto-account-switch",
      "disable-auto-account-switch"
    ]
  });
```
3. After the review-gate handling block (lines 229-235), add:
```js
  if (options["enable-auto-account-switch"] && options["disable-auto-account-switch"]) {
    throw new Error("Choose either --enable-auto-account-switch or --disable-auto-account-switch.");
  }
  if (options["enable-auto-account-switch"]) {
    setConfig(workspaceRoot, "autoAccountSwitch", true);
    actionsTaken.push(`Enabled automatic Codex account switching for ${workspaceRoot}.`);
  } else if (options["disable-auto-account-switch"]) {
    setConfig(workspaceRoot, "autoAccountSwitch", false);
    actionsTaken.push(`Disabled automatic Codex account switching for ${workspaceRoot}.`);
  }
  if (options["auto-switch-threshold"] !== undefined) {
    const threshold = Number(options["auto-switch-threshold"]);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
      throw new Error("--auto-switch-threshold expects a percentage between 1 and 100.");
    }
    setConfig(workspaceRoot, "autoAccountSwitchThresholdPercent", threshold);
    actionsTaken.push(`Set the account switch threshold to ${threshold}% for ${workspaceRoot}.`);
  }
```
4. In `buildSetupReport` (line 182), after `const config = getConfig(workspaceRoot);` add:
```js
  const codexAuthStatus = getCodexAuthAvailability();
  const registry = readAccountRegistry();
  const accountSwitching = {
    enabled: Boolean(config.autoAccountSwitch),
    thresholdPercent: config.autoAccountSwitchThresholdPercent,
    codexAuth: codexAuthStatus,
    accounts: registry.available
      ? registry.accounts.map((account) => ({
          email: account.email,
          alias: account.alias,
          active: account.active,
          primaryUsedPercent: account.primaryUsedPercent,
          secondaryUsedPercent: account.secondaryUsedPercent
        }))
      : []
  };
```
and add `accountSwitching,` to the returned object (next to `reviewGateEnabled`). Also add next steps when the feature is enabled but its prerequisites are missing:
```js
  if (config.autoAccountSwitch && !codexAuthStatus.available) {
    nextSteps.push("Install codex-auth with `npm install -g @loongphy/codex-auth` (auto account switch is enabled but the binary is missing).");
  }
  if (config.autoAccountSwitch && codexAuthStatus.available && !registry.available) {
    nextSteps.push("Register accounts with `codex-auth login` or `codex-auth import` (auto account switch is enabled but no account registry was found).");
  }
```

- [ ] **Step 7: Document the flags in `plugins/codex/commands/setup.md`**

Add to the command doc's flag list (match the file's existing formatting):
```
- `--enable-auto-account-switch` / `--disable-auto-account-switch`: toggle automatic Codex account switching (requires the `codex-auth` CLI; switches to the least-used stored account when the active one crosses the usage threshold or hits a usage-limit error).
- `--auto-switch-threshold <percent>`: usage percentage (1-100, default 95) at which the preflight check switches accounts.
```

- [ ] **Step 8: Full suite + manual smoke, then commit**

Run: `$TEST_ENV node --test tests/*.test.mjs` — expect 109 pass, 0 fail.
Smoke:
```bash
node plugins/codex/scripts/codex-companion.mjs setup --json --cwd /tmp | head -40
```
Expected: JSON contains `"accountSwitching"` with both accounts and `"enabled": false`.
```bash
git add plugins/codex/scripts/lib/state.mjs plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/render.mjs plugins/codex/commands/setup.md tests/state.test.mjs tests/render.test.mjs
git commit -m "feat: auto-account-switch config, setup flags, and report section"
```

---

### Task 7: Switch orchestration in accounts.mjs (TDD)

**Files:**
- Modify: `plugins/codex/scripts/lib/accounts.mjs` (append)
- Test: `tests/accounts.test.mjs` (append)

**Interfaces:**
- Consumes: Tasks 3-5 exports; `getConfig` from `./state.mjs`; `restartBrokerSession` from `./broker-lifecycle.mjs`; `BROKER_ENDPOINT_ENV` from `./app-server.mjs`.
- Produces (used by Task 8):
  - `maybeAutoSwitchAccount(cwd, { onProgress?, deps? }) → Promise<{ switched: boolean, reason: string, toAccount?: string }>` — preflight: no-op unless config enables it AND active usage ≥ threshold AND a fallback exists.
  - `switchToFallbackAccount(cwd, { onProgress?, deps? }) → Promise<{ switched: boolean, reason: string, toAccount?: string }>` — unconditional failover used after a classified usage-limit error (still requires config enabled + fallback available).
  - Both emit progress strings via `onProgress(message)` (plain string — compatible with `emitProgress`'s pass-through contract in `codex.mjs:191-200`).

- [ ] **Step 1: Write the failing tests (append to `tests/accounts.test.mjs`)**

```js
import {
  maybeAutoSwitchAccount,
  switchToFallbackAccount
} from "../plugins/codex/scripts/lib/accounts.mjs";

function orchestrationDeps(overrides = {}) {
  const registry = readAccountRegistry({ registryPath: REGISTRY_FIXTURE_PATH });
  const calls = { switched: [], restarted: 0 };
  return {
    calls,
    deps: {
      getConfig: () => ({ autoAccountSwitch: true, autoAccountSwitchThresholdPercent: 95 }),
      readAccountRegistry: () => registry,
      readActiveRateLimits: async () => ({ primaryUsedPercent: 99, secondaryUsedPercent: 99 }),
      switchActiveAccount: (target) => {
        calls.switched.push(target.accountKey);
        return { switched: true, detail: `switched to ${target.email}` };
      },
      restartRuntime: async () => {
        calls.restarted += 1;
        return null;
      },
      ...overrides
    }
  };
}

test("maybeAutoSwitchAccount switches when active usage crosses the threshold", async () => {
  const { deps, calls } = orchestrationDeps();
  const result = await maybeAutoSwitchAccount("/tmp/workspace", { deps });
  assert.equal(result.switched, true);
  assert.equal(result.toAccount, "acct-key-a");
  assert.deepEqual(calls.switched, ["acct-key-a"]);
  assert.equal(calls.restarted, 1);
});

test("maybeAutoSwitchAccount is a no-op when the feature is disabled", async () => {
  const { deps, calls } = orchestrationDeps({
    getConfig: () => ({ autoAccountSwitch: false, autoAccountSwitchThresholdPercent: 95 })
  });
  const result = await maybeAutoSwitchAccount("/tmp/workspace", { deps });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "disabled");
  assert.deepEqual(calls.switched, []);
});

test("maybeAutoSwitchAccount stays put under the threshold", async () => {
  const { deps, calls } = orchestrationDeps({
    readActiveRateLimits: async () => ({ primaryUsedPercent: 40, secondaryUsedPercent: 10 })
  });
  const result = await maybeAutoSwitchAccount("/tmp/workspace", { deps });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "under-threshold");
  assert.deepEqual(calls.switched, []);
});

test("maybeAutoSwitchAccount falls back to registry usage when rate limits are unknown", async () => {
  const { deps } = orchestrationDeps({
    readActiveRateLimits: async () => ({ primaryUsedPercent: null, secondaryUsedPercent: null })
  });
  // Registry says the active account (acct-key-b) is at 99% -> still switches.
  const result = await maybeAutoSwitchAccount("/tmp/workspace", { deps });
  assert.equal(result.switched, true);
});

test("switchToFallbackAccount switches without a threshold check", async () => {
  const { deps, calls } = orchestrationDeps({
    readActiveRateLimits: async () => ({ primaryUsedPercent: null, secondaryUsedPercent: null })
  });
  const result = await switchToFallbackAccount("/tmp/workspace", { deps });
  assert.equal(result.switched, true);
  assert.deepEqual(calls.switched, ["acct-key-a"]);
  assert.equal(calls.restarted, 1);
});

test("switchToFallbackAccount refuses when no other account exists", async () => {
  const { deps, calls } = orchestrationDeps();
  deps.readAccountRegistry = () => ({
    available: true,
    activeAccountKey: "acct-key-b",
    accounts: [
      {
        accountKey: "acct-key-b",
        email: "account-b@example.com",
        active: true,
        primaryUsedPercent: 99,
        secondaryUsedPercent: 99
      }
    ]
  });
  const result = await switchToFallbackAccount("/tmp/workspace", { deps });
  assert.equal(result.switched, false);
  assert.equal(result.reason, "no-fallback");
  assert.deepEqual(calls.switched, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$TEST_ENV node --test tests/accounts.test.mjs` — expect FAIL (functions not exported).

- [ ] **Step 3: Implement the orchestration (append to `plugins/codex/scripts/lib/accounts.mjs`)**

Add imports at the top:
```js
import { BROKER_ENDPOINT_ENV } from "./app-server.mjs";
import { restartBrokerSession } from "./broker-lifecycle.mjs";
import { getConfig } from "./state.mjs";
```
Then append:
```js
function notify(onProgress, message) {
  if (onProgress && message) {
    onProgress(message);
  }
}

async function defaultRestartRuntime(cwd) {
  return restartBrokerSession(cwd, {
    endpoint: process.env[BROKER_ENDPOINT_ENV] ?? null
  });
}

function orchestrationDeps(overrides = {}) {
  return {
    getConfig,
    readAccountRegistry,
    readActiveRateLimits,
    switchActiveAccount,
    restartRuntime: defaultRestartRuntime,
    ...overrides
  };
}

async function performSwitch(cwd, deps, fallback, onProgress) {
  notify(
    onProgress,
    `Codex account limit handling: switching to ${fallback.email} and restarting the Codex runtime.`
  );
  await deps.restartRuntime(cwd);
  const switchResult = deps.switchActiveAccount(fallback);
  if (!switchResult.switched) {
    notify(onProgress, `Codex account switch failed: ${switchResult.detail}`);
    return { switched: false, reason: "switch-failed" };
  }
  notify(onProgress, switchResult.detail);
  return { switched: true, reason: "switched", toAccount: fallback.accountKey };
}

export async function maybeAutoSwitchAccount(cwd, options = {}) {
  const deps = orchestrationDeps(options.deps);
  const config = deps.getConfig(cwd);
  if (!config.autoAccountSwitch) {
    return { switched: false, reason: "disabled" };
  }

  const registry = deps.readAccountRegistry();
  if (!registry.available) {
    return { switched: false, reason: "codex-auth-unavailable" };
  }

  const threshold = config.autoAccountSwitchThresholdPercent;
  const active = registry.accounts.find((account) => account.active) ?? null;
  const limits = await deps.readActiveRateLimits(cwd);
  const activeUsed = Math.max(
    limits.primaryUsedPercent ?? active?.primaryUsedPercent ?? 0,
    limits.secondaryUsedPercent ?? active?.secondaryUsedPercent ?? 0
  );
  if (activeUsed < threshold) {
    return { switched: false, reason: "under-threshold" };
  }

  const fallback = pickFallbackAccount(registry);
  if (!fallback) {
    return { switched: false, reason: "no-fallback" };
  }

  return performSwitch(cwd, deps, fallback, options.onProgress);
}

export async function switchToFallbackAccount(cwd, options = {}) {
  const deps = orchestrationDeps(options.deps);
  const config = deps.getConfig(cwd);
  if (!config.autoAccountSwitch) {
    return { switched: false, reason: "disabled" };
  }

  const registry = deps.readAccountRegistry();
  if (!registry.available) {
    return { switched: false, reason: "codex-auth-unavailable" };
  }

  const fallback = pickFallbackAccount(registry);
  if (!fallback) {
    return { switched: false, reason: "no-fallback" };
  }

  return performSwitch(cwd, deps, fallback, options.onProgress);
}
```
Note the runtime restart happens **before** the credential switch, so no live app-server keeps serving with stale tokens; the respawned broker (or the next direct spawn) reads the new `auth.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `$TEST_ENV node --test tests/accounts.test.mjs` — expect PASS (20 tests). Full suite: `$TEST_ENV node --test tests/*.test.mjs` — expect 115 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/lib/accounts.mjs tests/accounts.test.mjs
git commit -m "feat: account switch orchestration with preflight and failover paths"
```

---

### Task 8: Wire preflight and failover into runAppServerTurn / runAppServerReview

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs:1002-1056` (`runAppServerReview`) and `codex.mjs:1095-1160` (`runAppServerTurn`)

**Interfaces:**
- Consumes: `maybeAutoSwitchAccount`, `switchToFallbackAccount`, `isUsageLimitError` from `./accounts.mjs`.
- Produces: unchanged public signatures — `runAppServerTurn(cwd, options)` and `runAppServerReview(cwd, options)` return the same result shape; callers (`handleTask`, `handleReview`, `task-worker`, the stop-gate hook) need no changes. New result field `accountSwitched: string|null` (the account key switched to, for rendering/debugging).

- [ ] **Step 1: Add the import**

In `plugins/codex/scripts/lib/codex.mjs`, next to the existing `./lib` imports (lines 42-45):
```js
import { isUsageLimitError, maybeAutoSwitchAccount, switchToFallbackAccount } from "./accounts.mjs";
```

- [ ] **Step 2: Refactor `runAppServerReview`**

Rename the current exported function body to an inner attempt and wrap it. The current body (lines 1002-1056) becomes `runAppServerReviewAttempt` **unchanged except** the availability check moves to the wrapper:
```js
async function runAppServerReviewAttempt(cwd, options = {}) {
  return withAppServer(cwd, async (client) => {
    // ... the existing body of runAppServerReview from `emitProgress(options.onProgress, "Starting Codex review thread.", ...)`
    // through the returned result object, byte-for-byte unchanged ...
  });
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  await maybeAutoSwitchAccount(cwd, { onProgress: options.onProgress });

  let result = await runAppServerReviewAttempt(cwd, options);
  if (result.error && isUsageLimitError(result.error)) {
    const failover = await switchToFallbackAccount(cwd, { onProgress: options.onProgress });
    if (failover.switched) {
      result = await runAppServerReviewAttempt(cwd, options);
      result.accountSwitched = failover.toAccount ?? null;
    }
  }
  return result;
}
```
(`switchToFallbackAccount` — defined in Task 7 — internally re-checks that `autoAccountSwitch` is enabled and that a usable fallback exists, so this wrapper needs no config reads of its own.)

- [ ] **Step 3: Refactor `runAppServerTurn` the same way**

The current body (lines 1095-1160) becomes `runAppServerTurnAttempt` (availability check moved out, everything else byte-for-byte unchanged), and:
```js
export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  await maybeAutoSwitchAccount(cwd, { onProgress: options.onProgress });

  let result = await runAppServerTurnAttempt(cwd, options);
  if (result.error && isUsageLimitError(result.error)) {
    const failover = await switchToFallbackAccount(cwd, { onProgress: options.onProgress });
    if (failover.switched) {
      const retryOptions = result.threadId
        ? { ...options, resumeThreadId: result.threadId }
        : options;
      result = await runAppServerTurnAttempt(cwd, retryOptions);
      result.accountSwitched = failover.toAccount ?? null;
    }
  }
  return result;
}
```
The task retry resumes the same thread (`resumeThreadId: result.threadId`): thread state lives in `CODEX_HOME` on disk, which both accounts share, so the new account continues the conversation instead of restarting it. Reviews use ephemeral threads, so the review retry starts fresh — that is correct, a review is idempotent.

**Failover is single-attempt by construction:** the retry calls `runAppServerTurnAttempt`, not `runAppServerTurn`, so a second usage-limit error (fallback also exhausted) surfaces as a normal failed result.

- [ ] **Step 4: Run the full suite**

Run: `$TEST_ENV node --test tests/*.test.mjs`
Expected: 115 pass, 0 fail (`runtime.test.mjs` exercises these entry points via the fake codex fixture; if any test stubs `runAppServerTurn` internals, adjust for the rename — behavior with `autoAccountSwitch: false` must be bit-identical to before).

- [ ] **Step 5: Manual smoke with the feature disabled (default)**

```bash
node plugins/codex/scripts/codex-companion.mjs task "Reply with the single word: pong" --cwd /tmp
```
Expected: normal completion on the currently active account, no switching messages.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/codex.mjs
git commit -m "feat: preflight account check and usage-limit failover in turn/review entry points"
```

---

### Task 9: Fork identity, docs, and version

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/codex/.claude-plugin/plugin.json`
- Modify: `plugins/codex/CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Rename the marketplace so it cannot collide with upstream**

In `.claude-plugin/marketplace.json` set `"name": "codex-fork"` (leave the plugin's own name `codex` unchanged) and bump both `metadata.version` and the plugin entry `version` to `1.1.0`. In `plugins/codex/.claude-plugin/plugin.json` set `"version": "1.1.0"`.

- [ ] **Step 2: Verify version consistency**

Run: `node scripts/bump-version.mjs --check`
Expected: exit 0. If it reports other files carrying the version (e.g. `package.json`), update them to `1.1.0` and rerun until clean.

- [ ] **Step 3: Document the feature**

- `plugins/codex/CHANGELOG.md`: add a `## 1.1.0` entry: "Automatic account switching: when `autoAccountSwitch` is enabled and the active ChatGPT account crosses the usage threshold (or a run fails with a usage-limit error), the plugin switches to the least-used account stored by `codex-auth`, restarts the shared Codex runtime, and retries once. New setup flags: `--enable-auto-account-switch`, `--disable-auto-account-switch`, `--auto-switch-threshold <percent>`."
- `README.md`: add a short "Fork: automatic account switching" section at the top stating this is a fork of `openai/codex-plugin-cc` with the auto-switch feature, requiring `npm install -g @loongphy/codex-auth` and accounts registered via `codex-auth login` / `codex-auth import`.

- [ ] **Step 4: Full suite and commit**

Run: `$TEST_ENV node --test tests/*.test.mjs` — expect 115 pass, 0 fail.
```bash
git add .claude-plugin/marketplace.json plugins/codex/.claude-plugin/plugin.json plugins/codex/CHANGELOG.md README.md package.json
git commit -m "chore: rebrand fork as codex-fork 1.1.0 with auto account switching"
```

---

### Task 10: Install the fork and verify live end-to-end

The fork replaces `codex@openai-codex` (both define the `/codex:*` command namespace — they must not be enabled simultaneously). Everything here runs from a NEW Claude Code session or plain terminal, not the session that authored the code, so hooks and env are picked up fresh.

- [ ] **Step 1: Register the local directory marketplace and swap plugins**

```bash
claude plugin marketplace add /Users/jakubmucha/repos/codex-plugin-cc
claude plugin disable codex@openai-codex
claude plugin install codex@codex-fork
claude plugin list
```
Expected: `codex@codex-fork` enabled at version 1.1.0, `codex@openai-codex` disabled. (Verify exact subcommand names with `claude plugin --help` if any of these differ; the local-directory marketplace mechanism is already proven on this machine by the `synpress` marketplace at `/Users/jakubmucha/repos/synpress-qa`.)

- [ ] **Step 2: Enable the feature and confirm the report**

In a repo where Codex is used (e.g. `synpress-ngen`), run:
```bash
node /Users/jakubmucha/repos/codex-plugin-cc/plugins/codex/scripts/codex-companion.mjs setup --json --enable-auto-account-switch | python3 -m json.tool | head -50
```
Expected: `"accountSwitching": { "enabled": true, "thresholdPercent": 95, ... }` listing both accounts with usage percents.

- [ ] **Step 3: Live failover test**

Precondition (true as of 2026-08-29): the active account `services@bodhi.ventures` is at 99% on both windows; `kub.much@gmail.com` is at 6%.
```bash
codex-auth list
node /Users/jakubmucha/repos/codex-plugin-cc/plugins/codex/scripts/codex-companion.mjs task "Reply with the single word: pong" --cwd /tmp
codex-auth list
```
Expected: the task emits a progress line about switching accounts and restarting the runtime, completes successfully, and the second `codex-auth list` shows `kub.much@gmail.com` as the active (`*`) account. Then confirm auth from the plugin's view:
```bash
node /Users/jakubmucha/repos/codex-plugin-cc/plugins/codex/scripts/codex-companion.mjs setup --json | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['detail'])"
```
Expected: `ChatGPT login active for kub.much@gmail.com`.

- [ ] **Step 4: Verify a Claude-session broker survives a switch**

Start a fresh Claude Code session (so the SessionStart hook exports the broker endpoint), run `/codex:setup` (expect `session runtime: shared session` after the first task), run a `/codex:rescue` or task, and confirm subsequent commands still report `shared session` — i.e. the restarted broker was rebound on the same endpoint. If it reports `direct startup` instead, that is the documented graceful degradation, not a failure — but note it.

- [ ] **Step 5: Final verification gate**

Use the `superpowers:verification-before-completion` skill: rerun the full test suite, re-check `git status` is clean, and only then report completion. Optionally push the branch to a personal GitHub fork for backup:
```bash
git remote add upstream https://github.com/openai/codex-plugin-cc   # already origin; add personal fork as needed
```

---

## Risks and open points

- **`account/rateLimits/read` response shape** is confirmed only by the Task 2 fixture; Tasks 4/7 explicitly defer to the fixture. If the method is unsupported, preflight degrades to registry-cached usage (may be stale) and the reactive failover path still works.
- **codex-auth registry freshness/semantics:** the fallback account's cached `used_percent` is stale and possibly inverted (see Amendment), so it only orders candidates. Worst case we switch to an also-exhausted account; the single-attempt retry then fails with a clear usage-limit error rather than looping. Refreshing via codex-auth's live API mode is deliberately avoided (account-restriction warning).
- **Windows:** the socket-unlink step in `restartBrokerSession` is POSIX-only by guard; this machine is macOS, Windows support keeps upstream behavior (restart returns null → direct transport).
- **Upstream drift:** the fork tracks `openai/codex-plugin-cc` (`origin`). Rebase `feature/auto-account-switch` onto upstream tags when new versions ship; the touched surface (2 entry points, 1 new lib, config defaults, render) is intentionally small.
- **In-flight broker jobs:** `restartBrokerSession` kills the broker; the preflight runs before a thread starts and the failover runs after a turn already failed, so no successful in-flight work is lost. Other concurrent Claude sessions sharing the same broker would see one interrupted turn — acceptable for a two-account single-user setup.
