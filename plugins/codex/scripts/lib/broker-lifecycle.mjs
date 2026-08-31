import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { isProcessAlive, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
export const WATCH_PID_ENV = "CODEX_COMPANION_BROKER_WATCH_PID";
export const WATCH_INTERVAL_ENV = "CODEX_COMPANION_BROKER_WATCH_INTERVAL_MS";
export const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const BROKER_STATE_FILE = "broker.json";

const BROKER_SESSION_DIR_PREFIX = "cxc-";
export const BROKER_SESSION_DIR_SENTINEL = ".codex-companion-broker";
// setInterval/setTimeout clamp anything above 2^31-1 to 1ms — a value that
// large would turn the watchdog into a busy loop, so reject it at the parse.
const MAX_PARSED_INTEGER = 2 ** 31 - 1;

export function parsePositiveInteger(value) {
  const raw = String(value ?? "").trim();
  // Decimal digits only: Number() alone would accept hex ("0x1F4") and
  // exponent ("1e9") forms, and parseInt would accept trailing junk ("2h").
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PARSED_INTEGER ? parsed : null;
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

export function createBrokerSessionDir() {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), BROKER_SESSION_DIR_PREFIX));
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

export async function sendBrokerShutdown(endpoint, timeoutMs = 2000) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    // A wedged broker can accept the connection and never answer; the caller
    // (notably the SessionEnd hook) must not hang on it — the kill path in
    // teardownBrokerSession covers a broker that ignores the RPC.
    const deadline = setTimeout(() => {
      socket.destroy();
      resolve();
    }, timeoutMs);
    deadline.unref?.();
    const finish = () => {
      clearTimeout(deadline);
      resolve();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      finish();
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

export async function waitForProcessExit(pid, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
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
  fs.rmSync(resolveBrokerStateFile(cwd), { force: true });
}

export async function isBrokerEndpointReady(endpoint) {
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
    // The child is ours and failed to become ready — kill it, or a slow-boot
    // broker that binds after this timeout survives as an unowned orphan.
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? terminateProcessTree
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

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  removeSessionDir = true,
  pid = null,
  killProcess = null
}) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  // force-tolerant removals: a broker reaping itself concurrently must not be
  // able to crash this teardown between an existence check and an unlink.
  if (pidFile) {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  if (logFile) {
    try {
      fs.rmSync(logFile, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        fs.rmSync(target.path, { force: true });
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  if (!removeSessionDir) {
    return;
  }

  // Recursive removal is reserved for an EXPLICITLY passed session dir that
  // proves broker ownership via the creation-time sentinel. A dir merely
  // derived from pidFile/logFile can be steered through env vars, so it is
  // never recursed into: at most our own sentinel file is removed and the
  // then-empty dir rmdir'd. Anything that escapes this (a dir left non-empty)
  // is reclaimed later by sweepStaleBrokerSessionDirs.
  const resolvedSessionDir =
    sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (!resolvedSessionDir) {
    return;
  }

  if (sessionDir && isBrokerOwnedSessionDir(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore races with a broker removing its own session dir.
    }
    return;
  }

  if (isBrokerOwnedSessionDir(resolvedSessionDir)) {
    try {
      fs.rmSync(path.join(resolvedSessionDir, BROKER_SESSION_DIR_SENTINEL), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  try {
    fs.rmdirSync(resolvedSessionDir);
  } catch {
    // Ignore non-empty or missing directories.
  }
}

// Reclaims broker session dirs that escaped every teardown path: dirs from
// crashed/SIGKILLed brokers, pre-sentinel (1.3.0) dirs, and partially removed
// ones. Paths are constructed from our own enumeration of the OS temp root —
// never from persisted state — so removal here cannot be steered elsewhere.
// A dir is stale when its recorded broker pid is dead; a dir with no readable
// pid is age-gated so one that is mid-creation is never swept.
export function sweepStaleBrokerSessionDirs(options = {}) {
  const maxEntries = options.maxEntries ?? 50;
  const minAgeMs = options.minAgeMs ?? 24 * 60 * 60 * 1000;
  const tmpRoot = os.tmpdir();
  let names;
  try {
    names = fs.readdirSync(tmpRoot);
  } catch {
    return { examined: 0, removed: 0 };
  }

  let examined = 0;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(BROKER_SESSION_DIR_PREFIX)) {
      continue;
    }
    if (examined >= maxEntries) {
      break;
    }
    examined += 1;
    const dir = path.join(tmpRoot, name);
    try {
      const stats = fs.lstatSync(dir);
      if (!stats.isDirectory()) {
        continue;
      }
      let pidRaw = null;
      try {
        pidRaw = fs.readFileSync(path.join(dir, "broker.pid"), "utf8");
      } catch {
        pidRaw = null;
      }
      const brokerPid = parsePositiveInteger(pidRaw);
      if (brokerPid) {
        if (isProcessAlive(brokerPid)) {
          continue;
        }
      } else if (Date.now() - stats.mtimeMs < minAgeMs) {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Skip entries we cannot inspect or remove.
    }
  }
  return { examined, removed };
}

export async function restartBrokerSession(cwd, options = {}) {
  const env = options.env ?? process.env;
  const stored = loadBrokerSession(cwd);
  const endpoint = options.endpoint ?? stored?.endpoint ?? null;
  if (!endpoint) {
    return null;
  }

  // Only trust the stored record when it describes the SAME endpoint being
  // restarted — inheriting pid/paths from a non-matching record would kill
  // and delete an unrelated broker's runtime.
  const existing = stored && stored.endpoint === endpoint ? stored : null;

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
  // The replacement rebinds into the SAME dir, so keep it (sentinel included)
  // and remove only the runtime files.
  teardownBrokerSession({
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    removeSessionDir: false,
    pid,
    killProcess: options.killProcess ?? terminateProcessTree
  });
  clearBrokerSession(cwd);

  // Do not rebind while the outgoing broker can still be running its exit
  // path — its late cleanup must never overlap the replacement's files.
  if (pid) {
    await waitForProcessExit(pid, options.predecessorExitTimeoutMs ?? 2000);
  }

  // The session dir normally survives the teardown above. If something else
  // removed it, recreate it with mkdtemp's 0700 (the socket's only access
  // control) and re-claim ownership only for a dir created fresh under our
  // own naming — a user-supplied endpoint dir must never be claimed.
  const bindDir = sessionDir ?? endpointDir;
  if (bindDir && !fs.existsSync(bindDir)) {
    fs.mkdirSync(bindDir, { recursive: true, mode: 0o700 });
    if (isBrokerNamedDir(bindDir)) {
      markBrokerSessionDir(bindDir);
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
