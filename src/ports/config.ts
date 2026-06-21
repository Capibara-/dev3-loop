// The config seam: resolves the effective CardPolicy for a card from repo defaults (policy
// file) plus per-card overrides. The implementor/reviewer-independence assertion is enforced
// where the policy is loaded, not in the pure domain.

import type { Card, CardPolicy } from "../domain/types.ts";

export interface ConfigPort {
  // repo defaults (CRABBOX.md / .dev3-loop.yaml) overlaid with per-card overrides from the
  // card's labels/description.
  policyFor(card: Card): Promise<CardPolicy>;
}
