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
