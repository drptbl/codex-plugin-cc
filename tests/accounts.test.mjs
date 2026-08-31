import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  isUsageLimitError,
  maybeAutoSwitchAccount,
  normalizeRateLimits,
  pickFallbackAccount,
  readAccountRegistry,
  switchActiveAccount,
  switchToFallbackAccount
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
