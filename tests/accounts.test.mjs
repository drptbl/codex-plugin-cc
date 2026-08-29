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
