// RuntimePort over real tmux. dev-3.0 runs each task's agent in a tmux session dev3-<id8> on
// the `dev3` socket. The file signals (.dev3/result.json / review.json in the worktree) are the
// AUTHORITATIVE completion source; pane scraping is best-effort heartbeat only. // DISCOVERY:
// capture-pane can HANG on a control-mode (GUI-attached) session and there is no CLI-socket RPC
// for pane text, so capture() goes through the timeout-guarded exec seam and returns null on a
// hang rather than ever blocking the reconcile tick.
//
// This adapter owns the tmux mechanics + worktree file reads. The richer reviewer-launch
// semantics (move to review-by-ai with overridden builtinColumnAgents) land with the reviewer
// stage; launchGrader here just delivers the prompt into the pane like the other launches.

import { readFile } from "node:fs/promises";
import type { AgentSpec, Card } from "../../domain/types.ts";
import type { ImplementorResult, Review } from "../../ports/dto.ts";
import type { RuntimePort } from "../../ports/runtime.ts";
import { exec, type ExecResult } from "../exec/index.ts";
import { shortId } from "../dev3/map.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000; // short: a capture-pane hang must not stall the tick

export interface TmuxRuntimeOptions {
  socketName?: string; // tmux -L <name>; default "dev3"
  tmuxBin?: string; // default "tmux"
  timeoutMs?: number;
  captureTimeoutMs?: number;
}

export class TmuxRuntime implements RuntimePort {
  private readonly socketName: string;
  private readonly tmux: string;
  private readonly timeoutMs: number;
  private readonly captureTimeoutMs: number;

  constructor(opts: TmuxRuntimeOptions = {}) {
    this.socketName = opts.socketName ?? "dev3";
    this.tmux = opts.tmuxBin ?? "tmux";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  }

  async launchProducer(card: Card, _spec: AgentSpec, prompt: string): Promise<void> {
    await this.sendKeys(card, prompt);
  }

  async launchGrader(card: Card, _spec: AgentSpec, prompt: string): Promise<void> {
    await this.sendKeys(card, prompt);
  }

  async sendFixPrompt(card: Card, text: string): Promise<void> {
    await this.sendKeys(card, text);
  }

  // Best-effort pane scrape for the heartbeat. null when the session is gone, the read errors,
  // or it times out (a control-mode hang) — never throws, never blocks beyond captureTimeoutMs.
  async capture(card: Card): Promise<string | null> {
    const r = await exec(
      this.tmux,
      ["-L", this.socketName, "capture-pane", "-p", "-t", this.session(card)],
      { timeoutMs: this.captureTimeoutMs },
    );
    if (r.timedOut || r.code !== 0) return null;
    return r.stdout;
  }

  async isAlive(card: Card): Promise<boolean> {
    const r = await this.tmuxRun(["has-session", "-t", this.session(card)]);
    return r.code === 0 && !r.timedOut;
  }

  readResult(card: Card): Promise<ImplementorResult | null> {
    return this.readJson(card, "result.json", isImplementorResult);
  }

  readReview(card: Card): Promise<Review | null> {
    return this.readJson(card, "review.json", isReview);
  }

  // ---- internals ----

  private session(card: Card): string {
    return `dev3-${shortId(card.id)}`;
  }

  // Send literal text then Enter (two calls: -l keeps the body from being parsed as key names;
  // Enter is a separate keystroke). No-op-safe: a missing session just yields a non-zero exit.
  private async sendKeys(card: Card, text: string): Promise<void> {
    const target = this.session(card);
    await this.tmuxRun(["send-keys", "-t", target, "-l", text]);
    await this.tmuxRun(["send-keys", "-t", target, "Enter"]);
  }

  private tmuxRun(args: readonly string[]): Promise<ExecResult> {
    return exec(this.tmux, ["-L", this.socketName, ...args], { timeoutMs: this.timeoutMs });
  }

  private async readJson<T>(
    card: Card,
    name: string,
    guard: (v: unknown) => v is T,
  ): Promise<T | null> {
    if (card.worktreePath === null) return null;
    let text: string;
    try {
      text = await readFile(`${card.worktreePath}/.dev3/${name}`, "utf8");
    } catch {
      return null; // absent ⇒ nothing written yet
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return guard(parsed) ? parsed : null;
    } catch {
      return null; // half-written/torn ⇒ treat as not-yet-present
    }
  }
}

function isImplementorResult(v: unknown): v is ImplementorResult {
  return isRecord(v) && (v.status === "done" || v.status === "blocked");
}

function isReview(v: unknown): v is Review {
  return isRecord(v) && (v.verdict === "pass" || v.verdict === "changes_requested");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
