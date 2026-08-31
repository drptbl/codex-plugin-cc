#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import crypto from "node:crypto";

import { getConfig, listJobs, updateState } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
// Economics (2026-08-31): a review every turn-end re-reviewed stale turns and
// duplicated landed work. Skip when the repository fingerprint is unchanged
// since the last stop review, and rate-limit consecutive reviews.
const STOP_REVIEW_COOLDOWN_MS = 10 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

/// HEAD sha + a hash of the porcelain status — "did anything change since the
/// last stop review". null outside a git repo (always review there).
function computeRepoFingerprint(cwd) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (head.status !== 0) {
    return null;
  }
  const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  const dirty = porcelain.status === 0 ? porcelain.stdout : "";
  return crypto
    .createHash("sha1")
    .update(head.stdout.trim())
    .update("|")
    .update(dirty)
    .digest("hex");
}

function recordStopReview(workspaceRoot, fingerprint, at) {
  try {
    updateState(workspaceRoot, (state) => {
      state.config = state.config ?? {};
      state.config.stopReviewLastFingerprint = fingerprint;
      state.config.stopReviewLastAt = at;
    });
  } catch {
    // best-effort bookkeeping — a failed stamp must never break the gate
  }
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 15 minutes. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  // Economics: skip when nothing changed since the last stop review, and
  // rate-limit consecutive reviews. Visibility: every skip and every run says
  // so on stderr — background review work must never be a mystery again.
  const fingerprint = computeRepoFingerprint(cwd);
  const lastFingerprint = config.stopReviewLastFingerprint ?? null;
  const lastAt = Number(config.stopReviewLastAt ?? 0);
  const nowMs = Date.now();
  if (fingerprint && lastFingerprint && fingerprint === lastFingerprint) {
    logNote("[codex] stop-gate: repository unchanged since the last review — skipping.");
    logNote(runningTaskNote);
    return;
  }
  if (lastAt && nowMs - lastAt < STOP_REVIEW_COOLDOWN_MS) {
    const waitS = Math.round((STOP_REVIEW_COOLDOWN_MS - (nowMs - lastAt)) / 1000);
    logNote(`[codex] stop-gate: cooldown — last review ${Math.round((nowMs - lastAt) / 1000)}s ago, next in ~${waitS}s. Skipping.`);
    logNote(runningTaskNote);
    return;
  }
  logNote(`[codex] stop-gate review STARTING for ${cwd} (read-only sandbox; up to 15 min; /codex:status to inspect).`);
  const reviewStartedAt = Date.now();
  const review = runStopReview(cwd, input);
  recordStopReview(workspaceRoot, fingerprint, nowMs);
  logNote(`[codex] stop-gate review finished in ${Math.round((Date.now() - reviewStartedAt) / 1000)}s: ${review.ok ? "ALLOW" : "BLOCK"}.`);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
