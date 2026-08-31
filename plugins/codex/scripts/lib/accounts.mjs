import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { binaryAvailable } from "./process.mjs";
import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { restartBrokerSession } from "./broker-lifecycle.mjs";
import { getConfig } from "./state.mjs";

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
