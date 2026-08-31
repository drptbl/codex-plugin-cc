import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderSetupReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderSetupReport prints the account switching section when present", () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: "v24" },
    npm: { detail: "12" },
    codex: { detail: "codex-cli 0.150.1" },
    auth: { detail: "ChatGPT login active for account-b@example.com" },
    sessionRuntime: { label: "shared session" },
    reviewGateEnabled: false,
    accountSwitching: {
      enabled: true,
      thresholdPercent: 95,
      codexAuth: { available: true, detail: "codex-auth 0.2.10" },
      accounts: [
        { email: "account-b@example.com", alias: null, active: true, primaryUsedPercent: 99, secondaryUsedPercent: 99 },
        { email: "account-a@example.com", alias: null, active: false, primaryUsedPercent: 6, secondaryUsedPercent: 6 }
      ]
    },
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /auto account switch: enabled \(threshold 95%\)/);
  assert.match(output, /\* account-b@example\.com — 5h 99%, weekly 99%/);
  assert.match(output, /  account-a@example\.com — 5h 6%, weekly 6%/);
});
