// reviewerPreflight: the app layer that sources the effective reviewer config and reports the
// double-review hazards. Fed a fake ReviewerConfigSource — no server.

import { describe, expect, test } from "vitest";
import {
  formatFindings,
  hasBlockingFinding,
  reviewerPreflight,
  type ReviewerConfigSource,
} from "../../src/app/preflight.ts";
import { reviewByAiOverride, type ReviewerConfigState } from "../../src/domain/reviewer.ts";
import type { AgentSpec } from "../../src/domain/types.ts";

function source(state: ReviewerConfigState): ReviewerConfigSource {
  return { reviewerConfig: () => Promise.resolve(state) };
}

const reviewer: AgentSpec = { agent: "gemini", config: "gemini-default" };

describe("reviewerPreflight", () => {
  test("in-band, clean config ⇒ no findings, nothing blocking", async () => {
    const state: ReviewerConfigState = {
      autoReviewEnabled: true,
      reviewByAi: reviewByAiOverride(reviewer, "bun test"),
    };
    const findings = await reviewerPreflight(source(state), reviewer, "in-band");
    expect(findings).toEqual([]);
    expect(hasBlockingFinding(findings)).toBe(false);
    expect(formatFindings(findings)).toBe("preflight: reviewer config OK");
  });

  test("in-band, default fixer ⇒ a blocking error finding", async () => {
    const state: ReviewerConfigState = {
      autoReviewEnabled: true,
      reviewByAi: {
        agentId: "builtin-claude",
        configId: "claude-bypass-sonnet",
        prompt: "fix directly and commit",
      },
    };
    const findings = await reviewerPreflight(source(state), reviewer, "in-band");
    expect(hasBlockingFinding(findings)).toBe(true);
    expect(formatFindings(findings)).toMatch(/^\[error\]/);
  });

  test("out-of-band ⇒ never reads project config, never blocks (double-review impossible)", async () => {
    let read = false;
    const watched: ReviewerConfigSource = {
      reviewerConfig: () => {
        read = true;
        return Promise.resolve({ autoReviewEnabled: true, reviewByAi: null });
      },
    };
    const findings = await reviewerPreflight(watched, reviewer, "out-of-band");
    expect(read).toBe(false); // config not even consulted
    expect(hasBlockingFinding(findings)).toBe(false);
    expect(findings.every((f) => f.level === "info")).toBe(true);
  });
});
