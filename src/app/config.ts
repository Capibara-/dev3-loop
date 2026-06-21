/**
 * Config boot + validation (T9 — PLAN.md §11, constraint #6, §13 test 3).
 *
 * Loads the global config (state dir, store path, dev3 binary, tick interval,
 * concurrency cap, daily spend ceiling, default policy) and resolves the
 * effective {@link CardPolicy} per card: **repo defaults overlaid with per-card
 * overrides**. Everything is schema-validated and **fails fast** at boot with a
 * readable {@link ConfigError}.
 *
 * The single hard invariant enforced here is **producer ≠ grader** (PLAN §8,
 * constraint #6): an identical `(agent, config)` pair is a boot error; two specs
 * that differ only by config but resolve to the **same model** earn a warning
 * (grading must be model-independent — DISCOVERY §Q4).
 *
 * **Purity boundary:** parse + validate ({@link parseGlobalConfig},
 * {@link parseCardPolicy}, {@link resolvePolicy}, {@link assertDistinctAgents},
 * {@link resolveModel}) are pure and exhaustively unit-testable with zero I/O.
 * The **only** file I/O is {@link FileConfig.load}; tests use
 * {@link FileConfig.fromObject} (parsed object, no disk).
 *
 * The repo keeps `types: []` (no Node/Bun globals in scope), so — mirroring
 * `cli.ts` — we declare the tiny ambient surface this module actually touches
 * rather than pulling in `@types/node` / `@types/bun`.
 *
 * @module app/config
 */

import type { AgentSpec, Card, CardPolicy, MergePolicy } from "../domain/types.ts";
import type { ConfigPort } from "../ports/config.ts";

declare const console: { warn(...args: readonly unknown[]): void };
declare const Bun: { file(path: string): { text(): Promise<string> } };

// --- defaults -------------------------------------------------------------

/** Global-config defaults applied when a field is omitted (PLAN §11). */
export const CONFIG_DEFAULTS = {
  /** dev-3.0 JSON store root (DISCOVERY §18 / §Q-store). */
  dev3StorePath: "~/.dev3.0",
  /** Path/name of the `dev3` CLI binary used to mutate the board. */
  dev3Bin: "dev3",
  /** Reconcile-loop period in ms. */
  tickIntervalMs: 5_000,
  /** Fleet-wide live-card cap (PLAN §7; full policy is M3). */
  concurrencyCap: 20,
  /** Daily spend ceiling; `Infinity` ⇒ no ceiling (PLAN §7; enforcement is M3). */
  dailySpendCeiling: Number.POSITIVE_INFINITY,
} as const;

/** Per-card guardrail-cap defaults applied when a policy omits them (PLAN §4/§7). */
export const POLICY_DEFAULTS = {
  maxConsecutiveFailures: 3,
  maxTotalAttempts: 6,
  stallMs: 600_000,
} as const;

const MERGE_POLICIES: readonly MergePolicy[] = [
  "open_pr",
  "merge_when_green",
  "fix_until_green_and_merge",
];

// --- agent/config → model registry (DISCOVERY §Q4) ------------------------

/**
 * Resolved model per dev-3.0 `configId`, from the registry facts in
 * DISCOVERY §Q4. Used only to decide whether two **distinct** specs collapse to
 * the same model (a warn condition); an unknown config resolves to `undefined`
 * and is never treated as a collision.
 */
export const CONFIG_MODELS: Readonly<Record<string, string>> = {
  "claude-default": "fable-5",
  "claude-default-opus48": "opus-4.8",
  "claude-default-opus47": "opus-4.7",
  "claude-default-sonnet": "sonnet-4.6",
  "codex-default": "gpt-codex",
  "gemini-default": "gemini-3.1-pro",
  "gemini-flash": "gemini-flash",
  "cursor-default": "opus-4.6",
  "cursor-gpt": "gpt-5.3-codex",
  "cursor-gemini": "gemini-3.1-pro",
  "opencode-default": "opus-4.6",
};

/** Default `configId` per agent when an {@link AgentSpec} omits `config` (DISCOVERY §Q4). */
export const AGENT_DEFAULT_CONFIG: Readonly<Record<string, string>> = {
  "builtin-claude": "claude-default-opus48",
  "builtin-codex": "codex-default",
  "builtin-gemini": "gemini-default",
  "builtin-cursor": "cursor-default",
};

/** Permission-mode config suffixes that don't change the underlying model (DISCOVERY §Q4). */
const PERMISSION_SUFFIXES = ["-approvals", "-auto", "-bypass", "-dontask", "-plan"] as const;

/**
 * Resolve the underlying model for an {@link AgentSpec}, or `undefined` when it
 * can't be determined from the registry. Tolerates permission-mode suffixes
 * (e.g. `claude-default-opus48-bypass` resolves like `claude-default-opus48`)
 * and falls back to the agent's default config when `config` is omitted.
 */
export function resolveModel(spec: AgentSpec): string | undefined {
  const configId = spec.config ?? AGENT_DEFAULT_CONFIG[spec.agent];
  if (configId === undefined) return undefined;
  const direct = CONFIG_MODELS[configId];
  if (direct !== undefined) return direct;
  for (const suffix of PERMISSION_SUFFIXES) {
    if (configId.endsWith(suffix)) {
      const base = CONFIG_MODELS[configId.slice(0, -suffix.length)];
      if (base !== undefined) return base;
    }
  }
  return undefined;
}

// --- errors ---------------------------------------------------------------

/** Thrown on any boot-time config validation failure; carries a readable message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// --- producer ≠ grader (PLAN §8, constraint #6, §13 test 3) ---------------

function sameAgentSpec(a: AgentSpec, b: AgentSpec): boolean {
  return a.agent === b.agent && (a.config ?? undefined) === (b.config ?? undefined);
}

function specLabel(spec: AgentSpec): string {
  return spec.config ? `${spec.agent}/${spec.config}` : `${spec.agent} (default config)`;
}

/**
 * Enforce producer/grader independence for one resolved pairing (PLAN §8).
 *
 * - **HARD** — identical `(agent, config)` ⇒ throws {@link ConfigError}.
 * - **SOFT** — distinct specs that resolve to the same model ⇒ returns a warning
 *   string (the caller emits it); grading is then not model-independent.
 *
 * @returns the warning string, or `null` when the pairing is fully independent.
 */
export function assertDistinctAgents(
  producer: AgentSpec,
  grader: AgentSpec,
  where: string,
): string | null {
  if (sameAgentSpec(producer, grader)) {
    throw new ConfigError(
      `${where}: producer and grader must differ but both are "${specLabel(producer)}". ` +
        `The grader must be an independent invocation (ideally a different model) — ` +
        `pick a different agent or config (e.g. producer builtin-claude/claude-default-opus48, ` +
        `grader builtin-gemini/gemini-default).`,
    );
  }
  const producerModel = resolveModel(producer);
  const graderModel = resolveModel(grader);
  if (producerModel !== undefined && graderModel !== undefined && producerModel === graderModel) {
    return (
      `${where}: producer "${specLabel(producer)}" and grader "${specLabel(grader)}" differ only by ` +
      `config but resolve to the same model "${producerModel}" — grading is not model-independent ` +
      `(PLAN §8). Prefer a different-model grader.`
    );
  }
  return null;
}

// --- pure validators ------------------------------------------------------

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(`${where} must be an object`);
  }
  return v as Record<string, unknown>;
}

function strOr(v: unknown, fallback: string, where: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`${where} must be a non-empty string`);
  }
  return v;
}

function posInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(`${where} must be a positive integer`);
  }
  return v;
}

function posIntOr(v: unknown, fallback: number, where: string): number {
  return v === undefined ? fallback : posInt(v, where);
}

function nonNegNumberOr(v: unknown, fallback: number, where: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || Number.isNaN(v) || v < 0) {
    throw new ConfigError(`${where} must be a non-negative number`);
  }
  return v;
}

function parseMerge(v: unknown, where: string): MergePolicy {
  if (typeof v !== "string" || !MERGE_POLICIES.includes(v as MergePolicy)) {
    throw new ConfigError(`${where} must be one of: ${MERGE_POLICIES.join(", ")}`);
  }
  return v as MergePolicy;
}

function parseAgentSpec(v: unknown, where: string): AgentSpec {
  const o = asObject(v, where);
  const agent = o["agent"];
  if (typeof agent !== "string" || agent.length === 0) {
    throw new ConfigError(`${where}.agent must be a non-empty string`);
  }
  const config = o["config"];
  if (config !== undefined && (typeof config !== "string" || config.length === 0)) {
    throw new ConfigError(`${where}.config must be a non-empty string when present`);
  }
  return config === undefined ? { agent } : { agent, config };
}

function parseTokenBudget(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ConfigError(`${where} must be a non-negative finite number when present`);
  }
  return v;
}

/**
 * Validate a **complete** {@link CardPolicy} (the global `defaultPolicy`):
 * `merge`, `producer`, `grader`, `checksCmd` are required; the guardrail caps
 * default from {@link POLICY_DEFAULTS} when omitted.
 */
export function parseCardPolicy(v: unknown, where: string): CardPolicy {
  const o = asObject(v, where);
  const producer = parseAgentSpec(o["producer"], `${where}.producer`);
  const grader = parseAgentSpec(o["grader"], `${where}.grader`);
  const checksCmd = strOr(o["checksCmd"], "", `${where}.checksCmd`);
  if (checksCmd.length === 0) {
    throw new ConfigError(`${where}.checksCmd must be a non-empty string`);
  }
  const policy: CardPolicy = {
    merge: parseMerge(o["merge"], `${where}.merge`),
    maxConsecutiveFailures: posIntOr(
      o["maxConsecutiveFailures"],
      POLICY_DEFAULTS.maxConsecutiveFailures,
      `${where}.maxConsecutiveFailures`,
    ),
    maxTotalAttempts: posIntOr(
      o["maxTotalAttempts"],
      POLICY_DEFAULTS.maxTotalAttempts,
      `${where}.maxTotalAttempts`,
    ),
    stallMs: posIntOr(o["stallMs"], POLICY_DEFAULTS.stallMs, `${where}.stallMs`),
    producer,
    grader,
    checksCmd,
  };
  const tokenBudget = o["tokenBudget"];
  return tokenBudget === undefined
    ? policy
    : { ...policy, tokenBudget: parseTokenBudget(tokenBudget, `${where}.tokenBudget`) };
}

/** A partial policy overlay (repo defaults or per-card overrides). */
export type PolicyOverrides = Partial<CardPolicy>;

/**
 * Validate a **partial** policy overlay — only the fields present are checked
 * and carried over. Used for repo-level defaults and per-card overrides.
 */
export function parsePolicyOverrides(v: unknown, where: string): PolicyOverrides {
  const o = asObject(v, where);
  const out: PolicyOverrides = {};
  if (o["merge"] !== undefined) out.merge = parseMerge(o["merge"], `${where}.merge`);
  if (o["maxConsecutiveFailures"] !== undefined) {
    out.maxConsecutiveFailures = posInt(o["maxConsecutiveFailures"], `${where}.maxConsecutiveFailures`);
  }
  if (o["maxTotalAttempts"] !== undefined) {
    out.maxTotalAttempts = posInt(o["maxTotalAttempts"], `${where}.maxTotalAttempts`);
  }
  if (o["stallMs"] !== undefined) out.stallMs = posInt(o["stallMs"], `${where}.stallMs`);
  if (o["tokenBudget"] !== undefined) out.tokenBudget = parseTokenBudget(o["tokenBudget"], `${where}.tokenBudget`);
  if (o["producer"] !== undefined) out.producer = parseAgentSpec(o["producer"], `${where}.producer`);
  if (o["grader"] !== undefined) out.grader = parseAgentSpec(o["grader"], `${where}.grader`);
  if (o["checksCmd"] !== undefined) {
    const cmd = o["checksCmd"];
    if (typeof cmd !== "string" || cmd.length === 0) {
      throw new ConfigError(`${where}.checksCmd must be a non-empty string`);
    }
    out.checksCmd = cmd;
  }
  return out;
}

/**
 * Overlay partial policies onto a complete base, **last writer wins**. Only keys
 * actually present in an override are applied (no key is ever cleared to
 * `undefined`), which keeps the result a complete {@link CardPolicy}.
 */
export function resolvePolicy(
  base: CardPolicy,
  ...overrides: ReadonlyArray<PolicyOverrides | undefined>
): CardPolicy {
  const merged: CardPolicy = { ...base };
  for (const o of overrides) {
    if (!o) continue;
    if (o.merge !== undefined) merged.merge = o.merge;
    if (o.maxConsecutiveFailures !== undefined) merged.maxConsecutiveFailures = o.maxConsecutiveFailures;
    if (o.maxTotalAttempts !== undefined) merged.maxTotalAttempts = o.maxTotalAttempts;
    if (o.stallMs !== undefined) merged.stallMs = o.stallMs;
    if (o.tokenBudget !== undefined) merged.tokenBudget = o.tokenBudget;
    if (o.producer !== undefined) merged.producer = o.producer;
    if (o.grader !== undefined) merged.grader = o.grader;
    if (o.checksCmd !== undefined) merged.checksCmd = o.checksCmd;
  }
  return merged;
}

/** Matches a fenced ```dev3-loop\n{json}\n``` block carrying per-card overrides. */
const CARD_OVERRIDE_FENCE = /```dev3-loop\s*\n([\s\S]*?)```/;

/**
 * Extract per-card policy overrides from a card's description (PLAN §11: "per-card
 * overrides from card labels/description"). A card may embed a fenced
 * ```dev3-loop``` block of JSON overrides; absent ⇒ `{}`. Pure — operates on the
 * already-loaded {@link Card.prompt}.
 */
export function parseCardPolicyOverrides(card: Card): PolicyOverrides {
  const match = CARD_OVERRIDE_FENCE.exec(card.prompt);
  if (!match) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]!);
  } catch (e) {
    throw new ConfigError(
      `card ${card.id}: dev3-loop override block is not valid JSON: ${(e as Error).message}`,
    );
  }
  return parsePolicyOverrides(raw, `card ${card.id} override`);
}

// --- global config --------------------------------------------------------

/** The fully-validated global configuration (PLAN §11). */
export interface GlobalConfig {
  /** Where the journal + event log live (required; no default). */
  stateDir: string;
  /** dev-3.0 JSON store root (default {@link CONFIG_DEFAULTS.dev3StorePath}). */
  dev3StorePath: string;
  /** `dev3` CLI binary path/name (default {@link CONFIG_DEFAULTS.dev3Bin}). */
  dev3Bin: string;
  /** Reconcile period in ms (default {@link CONFIG_DEFAULTS.tickIntervalMs}). */
  tickIntervalMs: number;
  /** Fleet live-card cap (default {@link CONFIG_DEFAULTS.concurrencyCap}). */
  concurrencyCap: number;
  /** Daily spend ceiling; `Infinity` ⇒ none (default {@link CONFIG_DEFAULTS.dailySpendCeiling}). */
  dailySpendCeiling: number;
  /** Baseline policy every card inherits before repo/card overrides. */
  defaultPolicy: CardPolicy;
  /** Per-repo (`owner/name`) policy overlays applied before per-card overrides. */
  repoPolicies: Record<string, PolicyOverrides>;
}

/** Result of {@link parseGlobalConfig}: the config plus any soft warnings. */
export interface ParsedGlobalConfig {
  config: GlobalConfig;
  /** Non-fatal independence warnings (same-model producer/grader); caller emits them. */
  warnings: string[];
}

/**
 * Validate a raw (already-JSON-parsed) global-config object. Fills defaults,
 * **fails fast** with a readable {@link ConfigError} on any schema violation, and
 * runs the producer≠grader assertion against the default policy **and** every
 * repo-resolved policy (PLAN §8/§11). Pure — no I/O.
 */
export function parseGlobalConfig(raw: unknown): ParsedGlobalConfig {
  const o = asObject(raw, "config");
  const warnings: string[] = [];

  const stateDir = o["stateDir"];
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new ConfigError("config.stateDir must be a non-empty string (where the journal + event log live)");
  }

  if (o["defaultPolicy"] === undefined) {
    throw new ConfigError("config.defaultPolicy is required");
  }
  const defaultPolicy = parseCardPolicy(o["defaultPolicy"], "config.defaultPolicy");
  const defaultWarn = assertDistinctAgents(
    defaultPolicy.producer,
    defaultPolicy.grader,
    "config.defaultPolicy",
  );
  if (defaultWarn) warnings.push(defaultWarn);

  const repoPolicies: Record<string, PolicyOverrides> = {};
  if (o["repoPolicies"] !== undefined) {
    const rp = asObject(o["repoPolicies"], "config.repoPolicies");
    for (const repo of Object.keys(rp)) {
      const where = `config.repoPolicies["${repo}"]`;
      const overrides = parsePolicyOverrides(rp[repo], where);
      repoPolicies[repo] = overrides;
      // Boot-check the repo-resolved pairing too — a repo may override producer/grader.
      const merged = resolvePolicy(defaultPolicy, overrides);
      const repoWarn = assertDistinctAgents(merged.producer, merged.grader, where);
      if (repoWarn) warnings.push(repoWarn);
    }
  }

  const config: GlobalConfig = {
    stateDir,
    dev3StorePath: strOr(o["dev3StorePath"], CONFIG_DEFAULTS.dev3StorePath, "config.dev3StorePath"),
    dev3Bin: strOr(o["dev3Bin"], CONFIG_DEFAULTS.dev3Bin, "config.dev3Bin"),
    tickIntervalMs: posIntOr(o["tickIntervalMs"], CONFIG_DEFAULTS.tickIntervalMs, "config.tickIntervalMs"),
    concurrencyCap: posIntOr(o["concurrencyCap"], CONFIG_DEFAULTS.concurrencyCap, "config.concurrencyCap"),
    dailySpendCeiling: nonNegNumberOr(
      o["dailySpendCeiling"],
      CONFIG_DEFAULTS.dailySpendCeiling,
      "config.dailySpendCeiling",
    ),
    defaultPolicy,
    repoPolicies,
  };
  return { config, warnings };
}

// --- the ConfigPort boundary ----------------------------------------------

/** Sink for soft warnings; defaults to `console.warn`. */
export interface ConfigLogger {
  warn(message: string): void;
}

const DEFAULT_LOGGER: ConfigLogger = {
  warn: (message) => console.warn(message),
};

/**
 * File-backed {@link ConfigPort}. Resolves each card's policy as
 * `defaultPolicy ⊕ repoPolicies[card.repo] ⊕ cardOverrides`, re-asserting
 * producer≠grader on the resolved pairing (defense in depth — a per-card
 * override could reintroduce a collision).
 *
 * Construct via {@link FileConfig.load} (reads a JSON file — the only I/O here)
 * or {@link FileConfig.fromObject} (already-parsed object, no disk).
 */
export class FileConfig implements ConfigPort {
  private constructor(
    /** The validated global config. */
    readonly global: GlobalConfig,
  ) {}

  /** Build from an already-parsed object (no file I/O); emits warnings via `logger`. */
  static fromObject(raw: unknown, logger: ConfigLogger = DEFAULT_LOGGER): FileConfig {
    const { config, warnings } = parseGlobalConfig(raw);
    for (const w of warnings) logger.warn(w);
    return new FileConfig(config);
  }

  /** Read + parse a JSON config file at `path`. The only file I/O in this module. */
  static async load(path: string, logger: ConfigLogger = DEFAULT_LOGGER): Promise<FileConfig> {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (e) {
      throw new ConfigError(`cannot read config file at ${path}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ConfigError(`config file at ${path} is not valid JSON: ${(e as Error).message}`);
    }
    return FileConfig.fromObject(raw, logger);
  }

  // `async` so a failed independence re-check surfaces as a rejection (the
  // `ConfigPort` contract), not a synchronous throw.
  async policyFor(card: Card): Promise<CardPolicy> {
    const repoOverride = this.global.repoPolicies[card.repo];
    const cardOverride = parseCardPolicyOverrides(card);
    const resolved = resolvePolicy(this.global.defaultPolicy, repoOverride, cardOverride);
    assertDistinctAgents(resolved.producer, resolved.grader, `resolved policy for card ${card.id}`);
    return resolved;
  }
}
