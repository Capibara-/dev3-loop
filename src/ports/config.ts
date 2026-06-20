/**
 * The config seam: resolves the effective {@link CardPolicy} for a card from
 * repo defaults (policy file) plus per-card overrides (PLAN §5/§11).
 *
 * @module ports/config
 */

import type { Card, CardPolicy } from "../domain/types.ts";

/**
 * Resolves per-card policy. The producer/grader-independence assertion (PLAN §8,
 * §13 test 3) is enforced where the policy is loaded, not in the pure domain.
 */
export interface ConfigPort {
  /**
   * Resolve the effective policy for a card: repo defaults from the policy file
   * (`CRABBOX.md` / `.dev3-loop.yaml`) overlaid with per-card overrides parsed
   * from the card's labels/description.
   *
   * @param card the card to resolve policy for.
   * @returns the fully-resolved {@link CardPolicy}.
   */
  policyFor(card: Card): Promise<CardPolicy>;
}
