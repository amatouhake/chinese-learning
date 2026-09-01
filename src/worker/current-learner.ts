import type { LearnerId } from "../domain/types";

// This is the only operational learner resolver today. A future authentication
// adapter will replace this fixed resolution with provider identity -> learner
// identity lookup; request payloads must never choose the learner.
export const FIXED_OWNER_LEARNER_ID: LearnerId = "learner:owner:v1";

export function resolveCurrentLearner(): LearnerId {
  return FIXED_OWNER_LEARNER_ID;
}
