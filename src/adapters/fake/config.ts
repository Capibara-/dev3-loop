// In-memory ConfigPort for tests. Returns a fixed default CardPolicy, overridable per card id.
// The implementor/reviewer independence assertion lives in the real config loader; this fake
// just hands back whatever policy the test supplies.

import type { Card, CardPolicy } from "../../domain/types.ts";
import type { ConfigPort } from "../../ports/config.ts";

export class FakeConfig implements ConfigPort {
  private overrides = new Map<string, CardPolicy>();

  constructor(private readonly defaultPolicy: CardPolicy) {}

  setPolicy(cardId: string, policy: CardPolicy): void {
    this.overrides.set(cardId, policy);
  }

  policyFor(card: Card): Promise<CardPolicy> {
    return Promise.resolve(this.overrides.get(card.id) ?? this.defaultPolicy);
  }
}
