/**
 * In-memory {@link ConfigPort} for tests (PLAN §5/§11). Returns a default
 * {@link CardPolicy} for every card, with optional per-card overrides. The
 * producer≠grader independence assertion lives in the real config loader (PLAN
 * §8) — this fake just hands back whatever policy the test supplies.
 *
 * @module adapters/fake/config
 */

import type { Card, CardPolicy } from "../../domain/types.ts";
import type { ConfigPort } from "../../ports/config.ts";

/** Resolves a fixed default policy, overridable per card id. */
export class FakeConfig implements ConfigPort {
  private overrides = new Map<string, CardPolicy>();

  constructor(private readonly defaultPolicy: CardPolicy) {}

  /** Override the resolved policy for a specific card. */
  setPolicy(cardId: string, policy: CardPolicy): void {
    this.overrides.set(cardId, policy);
  }

  policyFor(card: Card): Promise<CardPolicy> {
    return Promise.resolve(this.overrides.get(card.id) ?? this.defaultPolicy);
  }
}
