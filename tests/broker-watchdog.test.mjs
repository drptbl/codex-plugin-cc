import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  IDLE_TIMEOUT_ENV,
  WATCH_INTERVAL_ENV,
  WATCH_PID_ENV,
  clearBrokerSession,
  createBrokerSessionDir,
  ensureBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  spawnBrokerProcess,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
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

  teardownBrokerSession(session);
  assert.equal(fs.existsSync(session.sessionDir), false, "requester teardown reclaims the session dir");
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
