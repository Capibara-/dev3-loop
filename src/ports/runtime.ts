/**
 * The runtime seam: drives the tmux sessions + worktrees that dev-3.0 spawns
 * for each card, and reads the agents' status files.
 *
 * @module ports/runtime
 */

import type { AgentSpec, Card } from "../domain/types.ts";
import type { Review, ImplementorResult } from "./dto.ts";

/**
 * Launches and inspects the implementor/reviewer agents running inside dev-3.0's
 * tmux sessions and worktrees.
 *
 * All pane reads must be **timeout-guarded**: `capture-pane`/`list-windows` hang
 * on attached control-mode sessions, so file signals ({@link RuntimePort.readResult}
 * / {@link RuntimePort.readReview}) are the authoritative completion source and
 * raw captures are best-effort.
 */
export interface RuntimePort {
  /**
   * Start the implementor agent in the card's worktree with the given spec and
   * launch prompt. Called after the card has been promoted to `in-progress`
   * (dev-3.0 has spawned the worktree+session). Idempotent: a no-op if the
   * implementor is already running.
   *
   * @param card   the card to work.
   * @param spec   implementor agent + config.
   * @param prompt the full implementor launch prompt (incl. the result.json protocol).
   */
  launchProducer(card: Card, spec: AgentSpec, prompt: string): Promise<void>;

  /**
   * Launch the **independent** reviewer. The default adapter moves the
   * card to `review-by-ai` with `builtinColumnAgents` overridden to the reviewer
   * config + the adversarial read-only rubric; an out-of-band adapter is a drop-in
   * alternative the domain never sees. Must only be called after mechanical
   * checks are green.
   *
   * @param card   the card to review.
   * @param spec   reviewer agent + config (may match the implementor's; independence is
   *               by launch + rubric prompt + re-running checks, not config).
   * @param prompt the reviewer rubric prompt (diff + criteria + check output).
   */
  launchGrader(card: Card, spec: AgentSpec, prompt: string): Promise<void>;

  /**
   * Send fix findings into the **implementor's** existing pane so it keeps its
   * context for the fix. Used for both red-checks and
   * `changes_requested` fix loops.
   *
   * @param card the card whose implementor session receives the prompt.
   * @param text the findings / fix instructions to type into the pane.
   */
  sendFixPrompt(card: Card, text: string): Promise<void>;

  /**
   * Best-effort, server-mediated pane read (the `getTerminalPreview` RPC),
   * timeout-guarded. Used as a heartbeat-delta source, not for correctness
   *
   * @param card the card whose pane to read.
   * @returns the current pane text, or `null` if it could not be read in time.
   */
  capture(card: Card): Promise<string | null>;

  /**
   * Whether the card's tmux session/pane still exists.
   *
   * @param card the card to probe.
   * @returns true iff the agent session is alive.
   */
  isAlive(card: Card): Promise<boolean>;

  /**
   * Read the implementor's status file (`.dev3/result.json`) from the worktree.
   * Its presence is the implementor's completion signal; `claimedTestsPass` is
   * never trusted.
   *
   * @param card the card whose worktree to read.
   * @returns the parsed result, or `null` if absent/unparseable.
   */
  readResult(card: Card): Promise<ImplementorResult | null>;

  /**
   * Read the reviewer's verdict file (`.dev3/review.json`) from the worktree. The
   * verdict drives routing regardless of the current lane.
   *
   * @param card the card whose worktree to read.
   * @returns the parsed review, or `null` if absent/unparseable.
   */
  readReview(card: Card): Promise<Review | null>;
}
