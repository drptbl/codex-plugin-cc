#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import {
  IDLE_TIMEOUT_ENV,
  WATCH_INTERVAL_ENV,
  clearBrokerSession,
  isBrokerOwnedSessionDir,
  loadBrokerSession,
  parsePositiveInteger,
  resolveIdleTimeoutMs
} from "./lib/broker-lifecycle.mjs";
import { isProcessAlive } from "./lib/process.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const DEFAULT_WATCH_INTERVAL_MS = 5000;
// Hard ceiling on how long any exit path may take before the failsafe timer
// force-exits — a wedged codex child must never keep a dying broker alive.
const EXIT_DEADLINE_MS = 5000;
// A live session tears the broker down via the SessionEnd hook; the idle
// timeout is the production backstop for brokers whose session died without
// it (crash, SIGKILL, closed terminal) — --watch-pid is an embedder/test
// facility with no producer in normal plugin use. The next invocation lazily
// respawns a broker, so a generous default costs at most one cold start.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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
    throw new Error(
      "Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--session-dir <path>] [--watch-pid <pid>]"
    );
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
  if (options["watch-pid"] !== undefined && watchPid === null) {
    // Fail loud, not open: a malformed watch pid silently dropping the
    // liveness tie is how orphan pairs come back.
    process.stderr.write(`Ignoring invalid --watch-pid ${JSON.stringify(options["watch-pid"])}.\n`);
  }
  const watchIntervalMs = parsePositiveInteger(process.env[WATCH_INTERVAL_ENV]) ?? DEFAULT_WATCH_INTERVAL_MS;
  const idleTimeout = resolveIdleTimeoutMs(process.env[IDLE_TIMEOUT_ENV], DEFAULT_IDLE_TIMEOUT_MS);
  const idleTimeoutMs = idleTimeout.ms;
  if (idleTimeout.invalid) {
    process.stderr.write(
      `Ignoring invalid ${IDLE_TIMEOUT_ENV}=${JSON.stringify(process.env[IDLE_TIMEOUT_ENV])}; using default ${DEFAULT_IDLE_TIMEOUT_MS}ms.\n`
    );
  }
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
  let externalSignalReceived = false;

  // File/state cleanup for SELF-INITIATED exits only (watchdog, idle timeout,
  // app-server death, internal crash): nobody else knows this broker is going
  // away. Externally requested shutdowns (broker/shutdown RPC, SIGTERM/SIGINT)
  // must leave every file alone — the requester runs teardownBrokerSession
  // itself, and a restart rebinds into the same endpoint dir immediately, so a
  // late delete from the dying broker would destroy the replacement's socket.
  function removeOwnedFiles() {
    // Clear the workspace's broker.json FIRST (smallest race window with a
    // concurrent respawn) so reuseExistingBroker callers stop dialing a dead
    // endpoint. Keyed on OUR pid: a restarted successor reuses the endpoint
    // string, so an endpoint comparison would delete the successor's state.
    try {
      if (loadBrokerSession(cwd)?.pid === process.pid) {
        clearBrokerSession(cwd);
      }
    } catch {
      // Stale state is tolerated by ensureBrokerSession; never fail the exit.
    }
    try {
      if (listenTarget.kind === "unix") {
        fs.rmSync(listenTarget.path, { force: true });
      }
    } catch {
      // Best-effort cleanup during exit.
    }
    try {
      if (pidFile) {
        fs.rmSync(pidFile, { force: true });
      }
    } catch {
      // Best-effort cleanup during exit.
    }
    if (isBrokerOwnedSessionDir(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        // Best-effort: an open log fd on Windows can block removal.
      }
    }
  }

  appClient.setNotificationHandler(routeNotification);

  // Idle time is measured from the last moment the broker had zero clients;
  // the check below only fires with no sockets connected, so stamping on
  // close/error (plus boot) is sufficient — no per-chunk bookkeeping.
  let lastActivityAt = Date.now();

  function markActivity() {
    lastActivityAt = Date.now();
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
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
          // Flush the ack to the requester before the exit path destroys the
          // remaining sockets — end()'s callback fires once the data is out.
          if (!socket.destroyed) {
            await new Promise((resolve) => socket.end(resolve));
          }
          // Externally requested: the requester owns file cleanup (teardown),
          // and a restart is about to rebind into this endpoint dir.
          externalSignalReceived = true;
          await exitWith("Shutdown requested via broker/shutdown.", 0, { removeFiles: false });
          return;
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

    const releaseSocket = () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      markActivity();
    };
    socket.on("close", releaseSocket);
    socket.on("error", releaseSocket);
  });

  // Every exit funnels through here. The shuttingDown flag is owned by this
  // function and set before any await, so concurrent triggers (watchdog tick,
  // app-server death, signal, RPC, crash handler) collapse into one shutdown.
  async function exitWith(reason, code, { removeFiles }) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`${reason}\n`);
    // Failsafe: NOTHING may keep a dying broker alive — not a codex child
    // that ignores SIGTERM, not a peer that never closes. The unref'd timer
    // fires only if the graceful path below wedges.
    const failsafe = setTimeout(() => {
      try {
        if (removeFiles) {
          removeOwnedFiles();
        }
      } catch {
        // Exit regardless.
      }
      process.exit(code);
    }, EXIT_DEADLINE_MS);
    failsafe.unref?.();
    try {
      for (const socket of sockets) {
        socket.destroy();
      }
      await appClient.close().catch(() => {});
      // Deliberately NO server.close(): a graceful close makes libuv unlink
      // the socket PATH — including one a replacement broker has already
      // re-bound — and waits for every peer. process.exit closes the listener
      // fd without touching the path; who deletes the file is decided by
      // removeFiles (self-exit) or the requester's teardown (external).
    } catch {
      // Exit regardless — a wedged close must not keep the broker alive.
    }
    if (removeFiles) {
      removeOwnedFiles();
    }
    process.exit(code);
  }

  // Without a liveness tie the detached broker (and its codex app-server
  // child) outlives every owner that forgets — or crashes before — the
  // explicit broker/shutdown. Watch the owning pid when given one, and reap
  // ourselves after a long stretch with no connected clients.
  if (watchPid || idleTimeoutMs > 0) {
    const watchdog = setInterval(() => {
      if (shuttingDown) {
        return;
      }
      if (watchPid && !isProcessAlive(watchPid)) {
        void exitWith(`Watched pid ${watchPid} exited; shutting down broker.`, 0, { removeFiles: true });
        return;
      }
      if (idleTimeoutMs > 0 && sockets.size === 0 && Date.now() - lastActivityAt > idleTimeoutMs) {
        void exitWith(`No client activity for ${idleTimeoutMs}ms; shutting down idle broker.`, 0, { removeFiles: true });
      }
    }, watchIntervalMs);
    watchdog.unref();
  }

  // A broker whose codex app-server died can only answer with errors, yet its
  // live endpoint makes ensureBrokerSession keep reusing it. Exit instead so
  // the next invocation respawns a healthy pair. processExitPromise fires only
  // on real process death — exitPromise also resolves on protocol errors
  // (e.g. one unparseable stdout line) and must not kill a working broker.
  // terminateProcessTree signals our whole process GROUP, so on an external
  // kill the child's death can be observed before our own SIGTERM callback —
  // the externalSignalReceived flag keeps that ordering race from flipping
  // an external kill into the removeFiles branch.
  appClient.processExitPromise.then(() => {
    void exitWith("codex app-server exited; shutting down broker.", 1, {
      removeFiles: !externalSignalReceived
    });
  });

  process.on("SIGTERM", () => {
    externalSignalReceived = true;
    void exitWith("Received SIGTERM; shutting down broker.", 0, { removeFiles: false });
  });

  process.on("SIGINT", () => {
    externalSignalReceived = true;
    void exitWith("Received SIGINT; shutting down broker.", 0, { removeFiles: false });
  });

  // Crash routes must clean up like any other self-initiated exit — a listen
  // failure (stale socket, EACCES) is emitted asynchronously and would
  // otherwise kill the process without ever reaping the codex child.
  server.on("error", (error) => {
    void exitWith(`Broker listener error: ${error?.message ?? error}`, 1, { removeFiles: true });
  });

  process.on("uncaughtException", (error) => {
    void exitWith(`Uncaught exception: ${error?.stack ?? error}`, 1, { removeFiles: true });
  });

  process.on("unhandledRejection", (reason) => {
    void exitWith(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`, 1, {
      removeFiles: true
    });
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
