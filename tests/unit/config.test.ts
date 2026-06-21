/**
 * Config boot + validation tests (T9 — PLAN §11, §13 test 3).
 *
 * All pure: no real config file is read. `FileConfig.fromObject` parses an
 * in-memory object so the producer≠grader boot assertion, defaulting, and
 * repo/card policy resolution are exercised with zero I/O.
 */
import { describe, expect, test } from "vitest";
import type { Card } from "../../src/domain/types.ts";
import {
  CONFIG_DEFAULTS,
  ConfigError,
  FileConfig,
  POLICY_DEFAULTS,
  parseGlobalConfig,
  resolveModel,
  resolvePolicy,
} from "../../src/app/config.ts";

// --- builders -------------------------------------------------------------

/** A minimal valid raw global config; `over` patches top-level fields. */
function rawConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stateDir: "/var/dev3-loop",
    defaultPolicy: {
      merge: "merge_when_green",
      producer: { agent: "builtin-claude", config: "claude-default-opus48" },
      grader: { agent: "builtin-gemini", config: "gemini-default" },
      checksCmd: "bun run test && tsc --noEmit",
    },
    ...over,
  };
}

function mkCard(over: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    repo: "owner/name",
    baseBranch: "main",
    branch: "dev3/task-card1",
    worktreePath: null,
    lane: "todo",
    prompt: "do the thing",
    acceptanceCriteria: [],
    // policy is resolved by ConfigPort; this placeholder is never read by it.
    policy: {
      merge: "merge_when_green",
      maxConsecutiveFailures: 3,
      maxTotalAttempts: 6,
      stallMs: 600_000,
      producer: { agent: "builtin-claude" },
      grader: { agent: "builtin-gemini" },
      checksCmd: "x",
    },
    ...over,
  };
}

/** Collects warnings instead of writing to the console. */
function recorder(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m) => messages.push(m), messages };
}

// --- valid load + defaults ------------------------------------------------

test("valid config loads and fills global defaults", () => {
  const log = recorder();
  const cfg = FileConfig.fromObject(rawConfig(), log).global;

  expect(cfg.stateDir).toBe("/var/dev3-loop");
  expect(cfg.dev3StorePath).toBe(CONFIG_DEFAULTS.dev3StorePath);
  expect(cfg.dev3Bin).toBe(CONFIG_DEFAULTS.dev3Bin);
  expect(cfg.tickIntervalMs).toBe(CONFIG_DEFAULTS.tickIntervalMs);
  expect(cfg.concurrencyCap).toBe(CONFIG_DEFAULTS.concurrencyCap);
  expect(cfg.dailySpendCeiling).toBe(CONFIG_DEFAULTS.dailySpendCeiling);
  expect(log.messages).toEqual([]);
});

test("policy caps default when omitted, explicit values win", () => {
  const { config } = parseGlobalConfig(rawConfig());
  expect(config.defaultPolicy.maxConsecutiveFailures).toBe(POLICY_DEFAULTS.maxConsecutiveFailures);
  expect(config.defaultPolicy.maxTotalAttempts).toBe(POLICY_DEFAULTS.maxTotalAttempts);
  expect(config.defaultPolicy.stallMs).toBe(POLICY_DEFAULTS.stallMs);

  const { config: c2 } = parseGlobalConfig(
    rawConfig({
      defaultPolicy: {
        merge: "open_pr",
        maxConsecutiveFailures: 5,
        stallMs: 1_000,
        tokenBudget: 250_000,
        producer: { agent: "builtin-claude" },
        grader: { agent: "builtin-gemini" },
        checksCmd: "tsc --noEmit",
      },
    }),
  );
  expect(c2.defaultPolicy.maxConsecutiveFailures).toBe(5);
  expect(c2.defaultPolicy.stallMs).toBe(1_000);
  expect(c2.defaultPolicy.tokenBudget).toBe(250_000);
});

// --- §13 test 3: producer == grader ⇒ boot error --------------------------

describe("producer ≠ grader (PLAN §8, §13 test 3)", () => {
  test("identical agent+config ⇒ thrown boot error with a clear message", () => {
    const bad = rawConfig({
      defaultPolicy: {
        merge: "merge_when_green",
        producer: { agent: "builtin-claude", config: "claude-default-opus48" },
        grader: { agent: "builtin-claude", config: "claude-default-opus48" },
        checksCmd: "tsc --noEmit",
      },
    });
    expect(() => FileConfig.fromObject(bad)).toThrow(ConfigError);
    expect(() => FileConfig.fromObject(bad)).toThrow(/producer and grader must differ/);
  });

  test("identical agent with both configs absent ⇒ boot error", () => {
    const bad = rawConfig({
      defaultPolicy: {
        merge: "merge_when_green",
        producer: { agent: "builtin-claude" },
        grader: { agent: "builtin-claude" },
        checksCmd: "tsc --noEmit",
      },
    });
    expect(() => parseGlobalConfig(bad)).toThrow(/producer and grader must differ/);
  });

  test("a repo override that collapses producer==grader ⇒ boot error", () => {
    const bad = rawConfig({
      repoPolicies: {
        "owner/name": { grader: { agent: "builtin-claude", config: "claude-default-opus48" } },
      },
    });
    // default producer is builtin-claude/claude-default-opus48 → repo grader now matches it.
    expect(() => parseGlobalConfig(bad)).toThrow(/repoPolicies\["owner\/name"\].*must differ/s);
  });

  test("same model, different config ⇒ warns but loads", () => {
    const log = recorder();
    const cfg = FileConfig.fromObject(
      rawConfig({
        defaultPolicy: {
          merge: "merge_when_green",
          producer: { agent: "builtin-claude", config: "claude-default-opus48" },
          grader: { agent: "builtin-claude", config: "claude-default-opus48-bypass" },
          checksCmd: "tsc --noEmit",
        },
      }),
      log,
    );
    expect(cfg.global.defaultPolicy.merge).toBe("merge_when_green");
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toMatch(/same model "opus-4\.8"/);
  });

  test("genuinely different models ⇒ no warning", () => {
    const log = recorder();
    FileConfig.fromObject(rawConfig(), log); // claude opus-4.8 vs gemini-3.1-pro
    expect(log.messages).toEqual([]);
  });
});

// --- model registry -------------------------------------------------------

test("resolveModel tolerates permission suffixes and default config", () => {
  expect(resolveModel({ agent: "builtin-claude", config: "claude-default-opus48" })).toBe("opus-4.8");
  expect(resolveModel({ agent: "builtin-claude", config: "claude-default-opus48-bypass" })).toBe("opus-4.8");
  expect(resolveModel({ agent: "builtin-claude" })).toBe("opus-4.8"); // agent default config
  expect(resolveModel({ agent: "builtin-gemini", config: "gemini-default" })).toBe("gemini-3.1-pro");
  expect(resolveModel({ agent: "mystery-agent", config: "unknown-config" })).toBeUndefined();
});

// --- per-repo + per-card policy resolution --------------------------------

describe("policyFor resolution (repo defaults then card overrides)", () => {
  test("repo override overlays the default policy", async () => {
    const cfg = FileConfig.fromObject(
      rawConfig({
        repoPolicies: { "owner/name": { merge: "open_pr", maxTotalAttempts: 10 } },
      }),
    );
    const policy = await cfg.policyFor(mkCard());
    expect(policy.merge).toBe("open_pr"); // from repo override
    expect(policy.maxTotalAttempts).toBe(10); // from repo override
    expect(policy.maxConsecutiveFailures).toBe(POLICY_DEFAULTS.maxConsecutiveFailures); // from default
  });

  test("a repo without an override falls back to the default policy", async () => {
    const cfg = FileConfig.fromObject(rawConfig({ repoPolicies: { "other/repo": { merge: "open_pr" } } }));
    const policy = await cfg.policyFor(mkCard({ repo: "owner/name" }));
    expect(policy.merge).toBe("merge_when_green");
  });

  test("a fenced dev3-loop block in the description overrides repo + default", async () => {
    const cfg = FileConfig.fromObject(
      rawConfig({ repoPolicies: { "owner/name": { merge: "open_pr" } } }),
    );
    const card = mkCard({
      prompt: [
        "Implement the feature.",
        "```dev3-loop",
        JSON.stringify({ merge: "fix_until_green_and_merge", stallMs: 1234 }),
        "```",
      ].join("\n"),
    });
    const policy = await cfg.policyFor(card);
    expect(policy.merge).toBe("fix_until_green_and_merge"); // card wins over repo
    expect(policy.stallMs).toBe(1234);
  });

  test("a card override that reintroduces producer==grader ⇒ throws", async () => {
    const cfg = FileConfig.fromObject(rawConfig());
    const card = mkCard({
      prompt: [
        "```dev3-loop",
        JSON.stringify({ grader: { agent: "builtin-claude", config: "claude-default-opus48" } }),
        "```",
      ].join("\n"),
    });
    await expect(cfg.policyFor(card)).rejects.toThrow(/must differ/);
  });

  test("a card override that introduces same-model pairing ⇒ warns via logger", async () => {
    const log = recorder();
    const cfg = FileConfig.fromObject(rawConfig(), log);
    log.messages.length = 0; // clear boot-time messages
    const card = mkCard({
      prompt: [
        "```dev3-loop",
        // override grader to a permission-suffix variant of the same model (opus-4.8)
        JSON.stringify({ grader: { agent: "builtin-claude", config: "claude-default-opus48-auto" } }),
        "```",
      ].join("\n"),
    });
    await cfg.policyFor(card);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toMatch(/same model/);
  });
});

// --- resolvePolicy unit ---------------------------------------------------

test("resolvePolicy applies only present override keys, last writer wins", () => {
  const { config } = parseGlobalConfig(rawConfig());
  const base = config.defaultPolicy;
  const merged = resolvePolicy(base, { merge: "open_pr" }, { stallMs: 42 });
  expect(merged.merge).toBe("open_pr");
  expect(merged.stallMs).toBe(42);
  expect(merged.checksCmd).toBe(base.checksCmd); // untouched
  expect(base.merge).toBe("merge_when_green"); // base not mutated
});

// --- schema failures ------------------------------------------------------

describe("schema validation fails fast with readable errors", () => {
  test("missing stateDir", () => {
    expect(() => parseGlobalConfig({ defaultPolicy: rawConfig().defaultPolicy })).toThrow(/stateDir/);
  });

  test("missing defaultPolicy", () => {
    expect(() => parseGlobalConfig({ stateDir: "/x" })).toThrow(/defaultPolicy is required/);
  });

  test("invalid merge policy value", () => {
    expect(() =>
      parseGlobalConfig(rawConfig({ defaultPolicy: { ...(rawConfig().defaultPolicy as object), merge: "yolo" } })),
    ).toThrow(/merge must be one of/);
  });

  test("non-positive tickIntervalMs", () => {
    expect(() => parseGlobalConfig(rawConfig({ tickIntervalMs: 0 }))).toThrow(/tickIntervalMs must be a positive integer/);
  });

  test("missing checksCmd", () => {
    const dp = { ...(rawConfig().defaultPolicy as Record<string, unknown>) };
    delete dp["checksCmd"];
    expect(() => parseGlobalConfig(rawConfig({ defaultPolicy: dp }))).toThrow(/checksCmd/);
  });
});
