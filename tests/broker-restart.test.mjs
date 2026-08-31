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
  // Endpoints are URIs in this codebase (createBrokerEndpoint): unix:<path>.
  const socketPath = path.join(sessionDir, "broker.sock");
  const endpoint = `unix:${socketPath}`;
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
      // Simulate the new broker binding the same socket path (URI in, path bound).
      assert.equal(options.endpoint, endpoint);
      return {
        pid: 67890,
        bind: (listenOnSocket(socketPath).then((server) => {
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
