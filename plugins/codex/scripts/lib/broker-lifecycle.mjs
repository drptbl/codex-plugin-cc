import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
export const WATCH_PID_ENV = "CODEX_COMPANION_BROKER_WATCH_PID";
export const WATCH_INTERVAL_ENV = "CODEX_COMPANION_BROKER_WATCH_INTERVAL_MS";
export const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const BROKER_STATE_FILE = "broker.json";

const BROKER_SESSION_DIR_PREFIX = "cxc-";
const BROKER_SESSION_DIR_SENTINEL = ".codex-companion-broker";

export function parsePositiveInteger(value) {
  const raw = String(value ?? "").trim();
  // Number() rejects trailing junk ("2h") that parseInt would silently accept.
  const parsed = raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// A malformed idle-timeout value must fail SAFE: only an explicit "0" turns
// the reaper off; garbage ("2h", "", "-1") falls back to the default so a
// typo cannot silently disable the one crash backstop production has.
export function resolveIdleTimeoutMs(rawValue, defaultMs) {
  if (rawValue === undefined) {
    return { ms: defaultMs, invalid: false };
  }
  if (String(rawValue).trim() === "0") {
    return { ms: 0, invalid: false };
  }
  const parsed = parsePositiveInteger(rawValue);
  return parsed === null ? { ms: defaultMs, invalid: true } : { ms: parsed, invalid: false };
}

function resolveWatchPid(env) {
  return parsePositiveInteger(env?.[WATCH_PID_ENV]);
}

function isBrokerNamedDir(dir) {
  return path.basename(path.resolve(dir)).startsWith(BROKER_SESSION_DIR_PREFIX);
}

export function markBrokerSessionDir(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, BROKER_SESSION_DIR_SENTINEL), "", "utf8");
}

export function createBrokerSessionDir(prefix = BROKER_SESSION_DIR_PREFIX) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  markBrokerSessionDir(sessionDir);
  return sessionDir;
}

// A session dir is only trusted for recursive removal when ownership was
// established at creation time: the broker prefix in the name plus the
// sentinel file markBrokerSessionDir wrote into it. The value can arrive from
// persisted broker.json state or broker argv, which must not be able to steer
// a recursive delete anywhere else — and unlike a path-shape check against
// os.tmpdir(), the sentinel stays valid when the reaping process runs with a
// different TMPDIR than the creator.
export function isBrokerOwnedSessionDir(sessionDir) {
  if (!sessionDir) {
    return false;
  }
  try {
    return isBrokerNamedDir(sessionDir) && fs.existsSync(path.join(sessionDir, BROKER_SESSION_DIR_SENTINEL));
  } catch {
    return false;
  }
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, sessionDir = null, watchPid = null, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const args = [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile];
  if (sessionDir) {
    args.push("--session-dir", sessionDir);
  }
  if (watchPid) {
    args.push("--watch-pid", String(watchPid));
  }
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const spawnEnv = options.env ?? process.env;
  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    watchPid: options.watchPid ?? resolveWatchPid(spawnEnv),
    env: spawnEnv
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  // Recursive removal is reserved for dirs that prove broker ownership via
  // the creation-time sentinel; anything else (a persisted or derived path
  // that fails validation) is only removed once empty.
  const resolvedSessionDir =
    sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (!resolvedSessionDir || !fs.existsSync(resolvedSessionDir)) {
    return;
  }

  if (isBrokerOwnedSessionDir(resolvedSessionDir)) {
    try {
      fs.rmSync(resolvedSessionDir, { recursive: true, force: true });
    } catch {
      // Ignore races with a broker removing its own session dir.
    }
    return;
  }

  try {
    fs.rmdirSync(resolvedSessionDir);
  } catch {
    // Ignore non-empty or missing directories.
  }
}

export async function restartBrokerSession(cwd, options = {}) {
  const env = options.env ?? process.env;
  const existing = loadBrokerSession(cwd);
  const endpoint = options.endpoint ?? existing?.endpoint ?? null;
  if (!endpoint) {
    return null;
  }

  // Endpoints are URIs (`unix:/path/broker.sock`, `pipe:...` — see
  // broker-endpoint.mjs); every filesystem operation works on the PARSED path,
  // never the URI string.
  const parsed = parseBrokerEndpoint(endpoint);
  const endpointDir = parsed.kind === "unix" ? path.dirname(parsed.path) : null;
  const pidFile =
    existing?.pidFile ??
    env[PID_FILE_ENV] ??
    (endpointDir ? path.join(endpointDir, "broker.pid") : null);
  const logFile =
    existing?.logFile ??
    env[LOG_FILE_ENV] ??
    (endpointDir ? path.join(endpointDir, "broker.log") : null);
  const sessionDir = existing?.sessionDir ?? endpointDir;
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

  if (parsed.kind === "unix" && fs.existsSync(parsed.path)) {
    fs.rmSync(parsed.path, { force: true });
  }

  // teardownBrokerSession resolves a session dir from pidFile's dirname even
  // when passed sessionDir: null, and rmdirs it once emptied — so the endpoint
  // directory may be GONE here. The respawned broker must bind into an
  // existing dir (a missing one surfaces as EACCES on macOS). When we create
  // the dir fresh and it carries our mkdtemp naming, re-establish ownership so
  // the respawned broker's self-cleanup can reclaim it; a pre-existing dir
  // keeps whatever ownership marker it already has (a user-supplied endpoint
  // dir must never be claimed).
  if (endpointDir) {
    const existedBefore = fs.existsSync(endpointDir);
    fs.mkdirSync(endpointDir, { recursive: true });
    if (!existedBefore && isBrokerNamedDir(endpointDir)) {
      markBrokerSessionDir(endpointDir);
    }
  }

  const scriptPath =
    options.scriptPath ?? fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const spawnProcess = options.spawnProcess ?? spawnBrokerProcess;
  const child = spawnProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    watchPid: options.watchPid ?? resolveWatchPid(env),
    env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 5000);
  if (!ready) {
    // Mirror ensureBrokerSession: never leak a half-spawned broker. Passing
    // the known sessionDir lets the ownership-guarded recursive removal
    // reclaim the dir even though broker.log makes it non-empty.
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child?.pid ?? null,
      killProcess: options.killProcess ?? terminateProcessTree
    });
    return null;
  }

  const session = { endpoint, pidFile, logFile, sessionDir, pid: child.pid ?? null };
  saveBrokerSession(cwd, session);
  return session;
}
