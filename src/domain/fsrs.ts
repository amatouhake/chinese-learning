import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type FSRSParameters,
  type Grade,
} from "ts-fsrs";

import { compareCanonicalReviews } from "./ordering";
import type { CanonicalFsrsReview, FsrsCardProjection, SchedulerConfig } from "./types";

export const FSRS_ALGORITHM = "fsrs-6";
export const FSRS_IMPLEMENTATION = "ts-fsrs";
export const FSRS_IMPLEMENTATION_VERSION = "5.4.1";

export function createFsrsParameters(
  desiredRetention: number,
  overrides: Partial<FSRSParameters> = {},
): FSRSParameters {
  if (!(desiredRetention > 0 && desiredRetention < 1)) {
    throw new Error("desired retention must be between zero and one");
  }

  const parameters = generatorParameters({
    ...overrides,
    request_retention: desiredRetention,
    enable_fuzz: false,
  });

  assertDeterministicFsrsParameters(parameters);
  return parameters;
}

export function assertDeterministicFsrsParameters(value: unknown): asserts value is FSRSParameters {
  if (!isRecord(value)) {
    throw new Error("scheduler parameters must be an object");
  }

  const valid =
    isFiniteNumber(value.request_retention) &&
    value.request_retention > 0 &&
    value.request_retention < 1 &&
    isFiniteNumber(value.maximum_interval) &&
    value.maximum_interval > 0 &&
    Array.isArray(value.w) &&
    value.w.every(isFiniteNumber) &&
    typeof value.enable_fuzz === "boolean" &&
    typeof value.enable_short_term === "boolean" &&
    isStepArray(value.learning_steps) &&
    isStepArray(value.relearning_steps);

  if (!valid) {
    throw new Error("invalid persisted FSRS parameters");
  }

  if (value.enable_fuzz) {
    throw new Error("persisted scheduler configs must disable fuzz for deterministic replay");
  }
}

export function parseFsrsParameters(json: string): FSRSParameters {
  const parsed: unknown = JSON.parse(json);
  assertDeterministicFsrsParameters(parsed);
  return parsed;
}

export function replayFsrsHistory(
  reviews: readonly CanonicalFsrsReview[],
  configs: ReadonlyMap<string, SchedulerConfig>,
  emptyCardDueAt?: number,
): FsrsCardProjection {
  const ordered = [...reviews].sort(compareCanonicalReviews);
  const initialDueAt = ordered[0]?.occurredAt ?? emptyCardDueAt;

  if (initialDueAt === undefined) {
    throw new Error("empty history requires an explicit initial due time");
  }

  let card: Card = createEmptyCard(new Date(initialDueAt));

  for (const review of ordered) {
    const config = configs.get(review.schedulerConfigId);
    if (!config) {
      throw new Error(`missing scheduler config: ${review.schedulerConfigId}`);
    }

    assertDeterministicFsrsParameters(config.parameters);
    card = fsrs(config.parameters).next(
      card,
      new Date(review.occurredAt),
      review.rating as Grade,
    ).card;
  }

  return projectCard(card);
}

export function projectCard(card: Card): FsrsCardProjection {
  return {
    dueAt: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReviewAt: card.last_review?.getTime() ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStepArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((step) => typeof step === "string");
}
