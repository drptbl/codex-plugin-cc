#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { IDLE_TIMEOUT_ENV, WATCH_INTERVAL_ENV, parsePositiveInteger } from "./lib/broker-lifecycle.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const DEFAULT_WATCH_INTERVAL_MS = 5000;
// A live session tears the broker down via the SessionEnd hook; the idle
// timeout only exists to reap brokers whose session died without it (crash,
// SIGKILL, closed terminal). The next invocation lazily respawns one, so a
// generous default costs at most one app-server cold start.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "session-dir", "watch-pid"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const sessionDir = options["session-dir"] ? path.resolve(options["session-dir"]) : null;
  const watchPid = parsePositiveInteger(options["watch-pid"]);
  const watchIntervalMs = parsePositiveInteger(process.env[WATCH_INTERVAL_ENV]) ?? DEFAULT_WATCH_INTERVAL_MS;
  const idleTimeoutMs =
    process.env[IDLE_TIMEOUT_ENV] !== undefined
      ? (parsePositiveInteger(process.env[IDLE_TIMEOUT_ENV]) ?? 0)
      : DEFAULT_IDLE_TIMEOUT_MS;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  let shuttingDown = false;

  async function shutdown(server) {
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    // The broker owns its mkdtemp session dir (socket, pid file, log file).
    // Nobody else cleans it on self-initiated exits, so remove it here; the
    // SessionEnd teardown path tolerates it already being gone.
    if (sessionDir && fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        // Best-effort: an open log fd on Windows can block removal.
      }
    }
  }

  appClient.setNotificationHandler(routeNotification);

  let lastActivityAt = Date.now();

  function markActivity() {
    lastActivityAt = Date.now();
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    markActivity();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      markActivity();
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      markActivity();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      markActivity();
    });
  });

  async function exitWith(reason, code) {
    if (shuttingDown) {
      return;
    }
    process.stderr.write(`${reason}\n`);
    await shutdown(server);
    process.exit(code);
  }

  // Without a liveness tie the detached broker (and its codex app-server
  // child) outlives every owner that forgets — or crashes before — the
  // explicit broker/shutdown. Watch the owning pid when given one, and reap
  // ourselves after a long stretch with no connected clients.
  const watchdog = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    if (watchPid && !isProcessAlive(watchPid)) {
      void exitWith(`Watched pid ${watchPid} exited; shutting down broker.`, 0);
      return;
    }
    if (idleTimeoutMs > 0 && sockets.size === 0 && !activeStreamSocket && Date.now() - lastActivityAt > idleTimeoutMs) {
      void exitWith(`No client activity for ${idleTimeoutMs}ms; shutting down idle broker.`, 0);
    }
  }, watchIntervalMs);
  watchdog.unref();

  // A broker whose codex app-server died can only answer with errors, yet its
  // live endpoint makes ensureBrokerSession keep reusing it. Exit instead so
  // the next invocation respawns a healthy pair.
  appClient.exitPromise.then(() => {
    void exitWith("codex app-server exited; shutting down broker.", 1);
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
