import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  IDLE_TIMEOUT_ENV,
  WATCH_INTERVAL_ENV,
  WATCH_PID_ENV,
  clearBrokerSession,
  createBrokerSessionDir,
  ensureBrokerSession,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

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

test("broker exits after the idle timeout with no connected clients", async (t) => {
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
});
