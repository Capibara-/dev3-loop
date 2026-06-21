// In-memory RuntimePort for tests. Scriptable per-card result.json/review.json, liveness, and
// pane captures; records every launch and fix-prompt so tests can assert what the reconciler
// drove — with no tmux, worktree, or real agent. All reads default to "nothing yet"; use the
// set* helpers to script a card's state before a tick.

import type { AgentSpec, Card } from "../../domain/types.ts";
import type { Review, ImplementorResult } from "../../ports/dto.ts";
import type { RuntimePort } from "../../ports/runtime.ts";

export interface RuntimeCall {
  cardId: string;
  spec?: AgentSpec;
  prompt?: string;
}

export class FakeRuntime implements RuntimePort {
  readonly producerLaunches: RuntimeCall[] = [];
  readonly graderLaunches: RuntimeCall[] = [];
  readonly fixPrompts: RuntimeCall[] = [];

  private results = new Map<string, ImplementorResult>();
  private reviews = new Map<string, Review>();
  private alive = new Map<string, boolean>();
  private captures = new Map<string, string>();

  setResult(cardId: string, result: ImplementorResult): void {
    this.results.set(cardId, result);
  }

  setReview(cardId: string, review: Review): void {
    this.reviews.set(cardId, review);
  }

  setAlive(cardId: string, alive: boolean): void {
    this.alive.set(cardId, alive);
  }

  setCapture(cardId: string, text: string): void {
    this.captures.set(cardId, text);
  }

  launchProducer(card: Card, spec: AgentSpec, prompt: string): Promise<void> {
    this.producerLaunches.push({ cardId: card.id, spec, prompt });
    this.alive.set(card.id, true);
    return Promise.resolve();
  }

  launchGrader(card: Card, spec: AgentSpec, prompt: string): Promise<void> {
    this.graderLaunches.push({ cardId: card.id, spec, prompt });
    return Promise.resolve();
  }

  sendFixPrompt(card: Card, text: string): Promise<void> {
    this.fixPrompts.push({ cardId: card.id, prompt: text });
    return Promise.resolve();
  }

  capture(card: Card): Promise<string | null> {
    return Promise.resolve(this.captures.has(card.id) ? this.captures.get(card.id)! : null);
  }

  isAlive(card: Card): Promise<boolean> {
    return Promise.resolve(this.alive.get(card.id) ?? false);
  }

  readResult(card: Card): Promise<ImplementorResult | null> {
    return Promise.resolve(this.results.get(card.id) ?? null);
  }

  readReview(card: Card): Promise<Review | null> {
    return Promise.resolve(this.reviews.get(card.id) ?? null);
  }
}
