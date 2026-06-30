// The independent reviewer: rubric construction, the builtinColumnAgents override shape, and
// double-review hazard detection. All pure — no I/O.

import { describe, expect, test } from "vitest";
import {
  buildReviewerPrompt,
  detectReviewerHazards,
  reviewByAiOverride,
  reviewerRubric,
  REVIEW_PATH,
  type ReviewByAiAgent,
  type ReviewerConfigState,
} from "../../src/domain/reviewer.ts";
import type { AgentSpec, Card } from "../../src/domain/types.ts";

function mkCard(over: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    repo: "owner/sample",
    baseBranch: "main",
    branch: "dev3/task-card-1",
    worktreePath: "/wt/card-1",
    lane: "review-by-ai",
    prompt: "Implement the widget",
    acceptanceCriteria: [],
    policy: {
      merge: "merge_when_green",
      maxConsecutiveFailures: 3,
      maxTotalAttempts: 6,
      stallMs: 1000,
      implementor: { agent: "claude", config: "claude-default-opus48" },
      reviewer: { agent: "gemini", config: "gemini-default" },
      checksCmd: "bun test && tsc --noEmit",
    },
    ...over,
  };
}

describe("buildReviewerPrompt", () => {
  test("embeds the checks command, the diff base, the criteria, and the verdict contract", () => {
    const p = buildReviewerPrompt({
      baseBranch: "origin/main",
      checksCmd: "make ci",
      criteria: "The widget renders",
    });
    expect(p).toContain("make ci");
    expect(p).toContain("git diff origin/main");
    expect(p).toContain("The widget renders");
    expect(p).toContain(REVIEW_PATH);
    expect(p).toContain('"verdict"');
    // Read-only contract: never edit/commit/move.
    expect(p).toMatch(/Do NOT edit/i);
    expect(p).toMatch(/Do NOT move the task/i);
  });
});

describe("reviewerRubric (per-card)", () => {
  test("diffs origin/<base> and uses acceptance criteria when present", () => {
    const p = reviewerRubric(mkCard({ acceptanceCriteria: ["A", "B"] }));
    expect(p).toContain("git diff origin/main");
    expect(p).toContain("A\n   B"); // criteria block, indented
    expect(p).toContain("bun test && tsc --noEmit");
  });

  test("falls back to the full description when no criteria are parsed", () => {
    const p = reviewerRubric(mkCard({ acceptanceCriteria: [], prompt: "Build the thing" }));
    expect(p).toContain("Build the thing");
  });
});

describe("reviewByAiOverride", () => {
  test("maps the spec to the projects.json shape with the rubric prompt", () => {
    const agent = reviewByAiOverride({ agent: "gemini", config: "gemini-default" }, "bun test");
    expect(agent.agentId).toBe("builtin-gemini");
    expect(agent.configId).toBe("gemini-default");
    expect(agent.prompt).toContain(REVIEW_PATH);
    // Per-project prompt keeps dev-3.0's {baseBranch} token (one prompt serves every card).
    expect(agent.prompt).toContain("origin/{baseBranch}");
  });

  test("passes an already-builtin- agentId through and omits configId when absent", () => {
    const agent = reviewByAiOverride({ agent: "builtin-claude" }, "bun test");
    expect(agent.agentId).toBe("builtin-claude");
    expect(agent.configId).toBeUndefined();
  });

  test("independence is NOT by a distinct spec: reviewer may equal the implementor", () => {
    // Sharing the implementor's (agent, config) must not throw — independence is launch + rubric.
    const shared: AgentSpec = { agent: "claude", config: "claude-default-opus48" };
    const agent = reviewByAiOverride(shared, "bun test");
    expect(agent.agentId).toBe("builtin-claude");
    expect(agent.prompt).toContain("READ-ONLY reviewer");
  });
});

describe("detectReviewerHazards", () => {
  const ourReviewer = (): ReviewByAiAgent =>
    reviewByAiOverride({ agent: "gemini", config: "gemini-default" }, "bun test");
  const expected: AgentSpec = { agent: "gemini", config: "gemini-default" };

  test("clean: our read-only reviewer installed + autoReview on ⇒ no findings", () => {
    const state: ReviewerConfigState = { autoReviewEnabled: true, reviewByAi: ourReviewer() };
    expect(detectReviewerHazards(state, expected)).toEqual([]);
  });

  test("the default edit-and-commit fixer is flagged as an error (double-review)", () => {
    const fixer: ReviewByAiAgent = {
      agentId: "builtin-claude",
      configId: "claude-bypass-sonnet",
      prompt:
        "Review all changes. For medium/high severity: fix directly and commit. As the last step, " +
        "run: dev3 task move --status review-by-user",
    };
    const findings = detectReviewerHazards({ autoReviewEnabled: true, reviewByAi: fixer }, expected);
    expect(findings.some((f) => f.level === "error")).toBe(true);
    expect(findings[0]!.message).toMatch(/EDITS\/COMMITS|fixer/i);
  });

  test("no review-by-ai agent at all ⇒ error", () => {
    const findings = detectReviewerHazards({ autoReviewEnabled: true, reviewByAi: null }, expected);
    expect(findings.some((f) => f.level === "error")).toBe(true);
    expect(findings[0]!.message).toMatch(/no builtinColumnAgents/);
  });

  test("autoReviewEnabled off ⇒ warn (in-band launch won't fire)", () => {
    const state: ReviewerConfigState = { autoReviewEnabled: false, reviewByAi: ourReviewer() };
    const findings = detectReviewerHazards(state, expected);
    expect(findings.some((f) => f.level === "warn" && /autoReviewEnabled is off/.test(f.message))).toBe(
      true,
    );
  });

  test("our reviewer but a different model than policy ⇒ info, not error", () => {
    const claudeReviewer = reviewByAiOverride({ agent: "claude" }, "bun test");
    const findings = detectReviewerHazards(
      { autoReviewEnabled: true, reviewByAi: claudeReviewer },
      expected,
    );
    expect(findings.every((f) => f.level !== "error")).toBe(true);
    expect(findings.some((f) => f.level === "info")).toBe(true);
  });
});
