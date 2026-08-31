import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import os from "node:os";

import {
  BROKER_SESSION_DIR_SENTINEL,
  IDLE_TIMEOUT_ENV,
  WATCH_INTERVAL_ENV,
  WATCH_PID_ENV,
  clearBrokerSession,
  createBrokerSessionDir,
  ensureBrokerSession,
  loadBrokerSession,
  parsePositiveInteger,
  restartBrokerSession,
  sendBrokerShutdown,
  spawnBrokerProcess,
  sweepStaleBrokerSessionDirs,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { isProcessAlive } from "../plugins/codex/scripts/lib/process.mjs";

const BROKER_SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url));

async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function spawnAnchorProcess() {
  const anchor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  return anchor;
}

function registerBrokerCleanup(t, workspace, session, anchor = null) {
  t.after(() => {
    if (session?.pid) {
      try {
        process.kill(session.pid, "SIGKILL");
      } catch {
        // Broker already gone — the expected outcome.
      }
    }
    if (anchor) {
      try {
        anchor.kill("SIGKILL");
      } catch {
        // Anchor already gone.
      }
    }
    if (session?.sessionDir) {
      fs.rmSync(session.sessionDir, { recursive: true, force: true });
    }
    clearBrokerSession(workspace);
  });
}

test("broker exits and removes its session dir when the watched pid dies", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const anchor = spawnAnchorProcess();
  const env = {
    ...buildEnv(binDir),
    [WATCH_PID_ENV]: String(anchor.pid),
    [WATCH_INTERVAL_ENV]: "100"
  };

  const session = await ensureBrokerSession(workspace, { env });
  assert.notEqual(session, null, "broker should start");
  registerBrokerCleanup(t, workspace, session, anchor);

  assert.equal(isProcessAlive(session.pid), true, "broker should be running");
  assert.equal(fs.existsSync(session.sessionDir), true, "session dir should exist");

  anchor.kill("SIGKILL");

  await waitFor(() => !isProcessAlive(session.pid), 5000, "broker exit after watched pid died");
  await waitFor(() => !fs.existsSync(session.sessionDir), 2000, "session dir removal");
});

test("broker exits when its codex app-server child dies", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const env = {
    ...buildEnv(binDir),
    [WATCH_INTERVAL_ENV]: "100"
  };

  const session = await ensureBrokerSession(workspace, { env });
  assert.notEqual(session, null, "broker should start");
  registerBrokerCleanup(t, workspace, session);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(Number.isInteger(fakeState.appServerPid), true, "fake app-server should record its pid");

  process.kill(fakeState.appServerPid, "SIGKILL");

  await waitFor(() => !isProcessAlive(session.pid), 5000, "broker exit after app-server died");
  await waitFor(() => !fs.existsSync(session.sessionDir), 2000, "session dir removal");
});

test("teardown recursively removes a genuine broker-owned session dir", () => {
  const sessionDir = createBrokerSessionDir();
  fs.writeFileSync(path.join(sessionDir, "broker.log"), "log contents\n");

  teardownBrokerSession({ sessionDir, pidFile: null, logFile: null });

  assert.equal(fs.existsSync(sessionDir), false);
});

test("teardown refuses to recursively delete a session dir it does not own", () => {
  // Simulates a tampered/corrupt broker.json steering sessionDir at an
  // arbitrary non-empty directory: teardown must fall back to empty-only
  // removal and leave the contents intact.
  const victimDir = makeTempDir();
  const preciousFile = path.join(victimDir, "precious.txt");
  fs.writeFileSync(preciousFile, "must survive teardown\n");

  teardownBrokerSession({ sessionDir: victimDir, pidFile: null, logFile: null });

  assert.equal(fs.existsSync(preciousFile), true);
});

test("broker exits after the idle timeout, removes its session dir, and clears broker.json", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const env = {
    ...buildEnv(binDir),
    [IDLE_TIMEOUT_ENV]: "300",
    [WATCH_INTERVAL_ENV]: "100"
  };

  const session = await ensureBrokerSession(workspace, { env });
  assert.notEqual(session, null, "broker should start");
  registerBrokerCleanup(t, workspace, session);

  await waitFor(() => !isProcessAlive(session.pid), 5000, "broker exit after idle timeout");
  await waitFor(() => !fs.existsSync(session.sessionDir), 2000, "session dir removal");
  await waitFor(() => loadBrokerSession(workspace) === null, 2000, "broker.json cleared on self-exit");
});

test("an invalid idle-timeout env value falls back to the default instead of disabling the reaper", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const env = {
    ...buildEnv(binDir),
    [IDLE_TIMEOUT_ENV]: "2h",
    [WATCH_INTERVAL_ENV]: "100"
  };

  const session = await ensureBrokerSession(workspace, { env });
  assert.notEqual(session, null, "broker should start");
  registerBrokerCleanup(t, workspace, session);

  // With the fail-open bug, "2h" parsed to 0 and disabled reaping silently.
  // Fail-safe behavior keeps the default (2h) — the broker must still be
  // alive well past the misread-as-zero window, and must have logged why.
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(isProcessAlive(session.pid), true, "broker should still be running on the default timeout");
  await waitFor(
    () => fs.readFileSync(session.logFile, "utf8").includes("Ignoring invalid"),
    2000,
    "invalid idle-timeout warning in broker log"
  );
});

test("a broker/shutdown request leaves file cleanup to the requester", async (t) => {
  // Regression for the restart race: the dying broker must NOT delete its
  // socket/session dir after replying, because restartBrokerSession rebinds a
  // replacement broker into the same endpoint dir immediately.
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir) });
  assert.notEqual(session, null, "broker should start");
  registerBrokerCleanup(t, workspace, session);

  await sendBrokerShutdown(session.endpoint);
  await waitFor(() => !isProcessAlive(session.pid), 5000, "broker exit after broker/shutdown");

  assert.equal(fs.existsSync(session.sessionDir), true, "session dir must survive an RPC shutdown");
  // Regression: a graceful server.close() would make libuv unlink the socket
  // PATH — the broker must exit without touching it so a restart that has
  // already re-bound the same path is never clobbered.
  const socketPath = parseBrokerEndpoint(session.endpoint).path;
  assert.equal(fs.existsSync(socketPath), true, "socket file must survive an RPC shutdown");

  teardownBrokerSession(session);
  assert.equal(fs.existsSync(session.sessionDir), false, "requester teardown reclaims the session dir");
});

test("restartBrokerSession replaces the broker on the same endpoint without racing its predecessor", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const first = await ensureBrokerSession(workspace, { env });
  assert.notEqual(first, null, "first broker should start");
  registerBrokerCleanup(t, workspace, first);

  const second = await restartBrokerSession(workspace, { env });
  assert.notEqual(second, null, "restart should produce a replacement broker");
  t.after(() => {
    if (second?.pid) {
      try {
        process.kill(second.pid, "SIGKILL");
      } catch {
        // Replacement already gone.
      }
    }
  });

  assert.equal(second.endpoint, first.endpoint, "restart must reuse the endpoint");
  assert.notEqual(second.pid, first.pid, "restart must produce a new broker process");
  await waitFor(() => !isProcessAlive(first.pid), 5000, "old broker exit after restart");

  // Give the old broker's exit path time to run any (buggy) late cleanup,
  // then prove the replacement is still reachable and still the saved state.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await waitForBrokerEndpoint(second.endpoint, 1000), true, "replacement endpoint stays reachable");
  assert.equal(loadBrokerSession(workspace)?.pid, second.pid, "state must name the replacement");
});

test("teardown never recursively deletes a derived dir, even with a planted sentinel", () => {
  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  fs.writeFileSync(path.join(victimDir, BROKER_SESSION_DIR_SENTINEL), "");
  const preciousFile = path.join(victimDir, "precious.txt");
  fs.writeFileSync(preciousFile, "must survive derived teardown\n");

  // sessionDir NOT passed: the dir is only derived from pidFile — an input an
  // env var can steer — so recursion must never fire regardless of markers.
  teardownBrokerSession({ pidFile: path.join(victimDir, "broker.pid"), logFile: null });

  assert.equal(fs.existsSync(preciousFile), true, "derived-dir contents must survive");
  assert.equal(fs.existsSync(victimDir), true, "derived dir must survive while non-empty");
  fs.rmSync(victimDir, { recursive: true, force: true });
});

test("sweep reclaims dead-broker dirs and leaves live and fresh ones alone", () => {
  const staleDir = createBrokerSessionDir();
  fs.writeFileSync(path.join(staleDir, "broker.pid"), "999999999\n");
  fs.writeFileSync(path.join(staleDir, "broker.log"), "old broker\n");

  const liveDir = createBrokerSessionDir();
  fs.writeFileSync(path.join(liveDir, "broker.pid"), `${process.pid}\n`);

  // Legacy/mid-creation shape: no pid file — must be age-gated, not swept.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));

  try {
    sweepStaleBrokerSessionDirs({ maxEntries: 100000 });
    assert.equal(fs.existsSync(staleDir), false, "dead-broker dir should be swept");
    assert.equal(fs.existsSync(liveDir), true, "live-broker dir must survive");
    assert.equal(fs.existsSync(freshDir), true, "fresh pid-less dir must be age-gated");
  } finally {
    fs.rmSync(liveDir, { recursive: true, force: true });
    fs.rmSync(freshDir, { recursive: true, force: true });
    fs.rmSync(staleDir, { recursive: true, force: true });
  }
});

test("parsePositiveInteger accepts only plain decimal integers", () => {
  assert.equal(parsePositiveInteger("250"), 250);
  assert.equal(parsePositiveInteger(" 42 "), 42);
  for (const rejected of ["0", "-1", "2h", "", "1e3", "0x1F4", "1_000", "4294967296", null, undefined]) {
    assert.equal(parsePositiveInteger(rejected), null, `should reject ${JSON.stringify(rejected)}`);
  }
});

test("broker never recursively deletes a --session-dir it does not own", async (t) => {
  // Regression for the argv bypass: a sessionDir steered via persisted state
  // or the endpoint env var must not be recursively deleted on self-exit.
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const endpointDir = makeTempDir();
  const victimDir = makeTempDir();
  installFakeCodex(binDir);
  const preciousFile = path.join(victimDir, "precious.txt");
  fs.writeFileSync(preciousFile, "must survive broker exit\n");

  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd: workspace,
    endpoint: `unix:${path.join(endpointDir, "broker.sock")}`,
    pidFile: path.join(endpointDir, "broker.pid"),
    logFile: path.join(endpointDir, "broker.log"),
    sessionDir: victimDir,
    env: {
      ...buildEnv(binDir),
      [IDLE_TIMEOUT_ENV]: "300",
      [WATCH_INTERVAL_ENV]: "100"
    }
  });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Broker already gone — the expected outcome.
    }
  });

  await waitFor(() => !isProcessAlive(child.pid), 5000, "broker self-exit via idle timeout");
  assert.equal(fs.existsSync(preciousFile), true, "unowned session dir contents must survive");
});
