import { InvalidInputError } from "./errors";
import { parsePracticeContractVersion } from "./practice-contract";
import type {
  ReflexActivityType,
  ReflexAnswerRecord,
  ReflexCard,
  ReflexChoice,
  ReflexHistorySummary,
  QuizActivity,
  QuizChoiceCount,
} from "./types";

export const REFLEX_ACTIVITY_TYPES = [
  "hanzi_to_meaning",
  "meaning_to_hanzi",
  "hanzi_to_pinyin",
  "pinyin_to_hanzi",
] as const satisfies readonly ReflexActivityType[];

export const DEFAULT_REFLEX_SESSION_SIZE = 12;
export const MAX_REFLEX_SESSION_SIZE = 20;
export const DEFAULT_REFLEX_POOL_SIZE = 8;
export const REFLEX_SLOW_RESPONSE_MS = 2_500;
export const REFLEX_INTERACTION = "reflex-multiple-choice";
export const QUIZ_SELECTION_STRATEGY = "weak_and_slow_v1" as const;

export interface CreateReflexSessionInput {
  sessionId: string;
  deviceId: string;
  maxItems: number;
  activityType?: QuizActivity;
  choiceCount?: QuizChoiceCount;
  practiceContractVersion?: number;
}

export interface ReflexHistoryInput {
  attempts: number;
  incorrect: number;
  slow: number;
  averageResponseMs: number | null;
  lastTroubleAt: number | null;
}

export interface PresentedReflexQuestion {
  presentationId: string;
  round: number;
  card: ReflexCard;
  choices: ReflexChoice[];
}

export interface ReflexAttemptMetadata {
  interaction: typeof REFLEX_INTERACTION;
  presentationId: string;
  round: number;
  prompt: string;
  promptHint: string | null;
  answerChoiceId: string;
  selectedChoiceId: string;
  choiceCount: QuizChoiceCount;
  timingInterrupted: boolean;
  options: Array<ReflexChoice & { position: number }>;
}

export function parseCreateReflexSessionInput(value: unknown): CreateReflexSessionInput {
  const body = requiredRecord(value, "reflex session body");
  return {
    sessionId: boundedText(body.sessionId, "sessionId"),
    deviceId: boundedText(body.deviceId, "deviceId"),
    maxItems:
      body.maxItems === undefined
        ? DEFAULT_REFLEX_SESSION_SIZE
        : boundedInteger(body.maxItems, "maxItems", 4, MAX_REFLEX_SESSION_SIZE),
    activityType: quizActivity(body.activityType),
    choiceCount: quizChoiceCount(body.choiceCount),
    practiceContractVersion: parsePracticeContractVersion(body.practiceContractVersion, "reflex"),
  };
}

export function isReflexActivity(value: unknown): value is ReflexActivityType {
  return typeof value === "string" && (REFLEX_ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function reflexHistorySummary(input: ReflexHistoryInput, now: number): ReflexHistorySummary {
  const attempts = nonNegativeInteger(input.attempts, "attempts");
  const incorrect = nonNegativeInteger(input.incorrect, "incorrect");
  const slow = nonNegativeInteger(input.slow, "slow");
  const errorRate = attempts === 0 ? 0 : incorrect / attempts;
  const slowRate = attempts === 0 ? 0 : slow / attempts;
  const underPracticed = 3 / (1 + attempts);
  const recentTrouble =
    input.lastTroubleAt !== null && now - input.lastTroubleAt <= 7 * 24 * 60 * 60 * 1_000 ? 2 : 0;
  return {
    attempts,
    incorrect,
    slow,
    averageResponseMs: input.averageResponseMs,
    lastTroubleAt: input.lastTroubleAt,
    priority: roundScore(underPracticed + errorRate * 6 + slowRate * 3 + recentTrouble),
  };
}

export function selectReflexPool<T extends Pick<ReflexCard, "cardId" | "activityType" | "history">>(
  candidates: readonly T[],
  sessionId: string,
  poolSize = DEFAULT_REFLEX_POOL_SIZE,
): T[] {
  const selected: T[] = [];
  const used = new Set<string>();
  const groups = new Map<ReflexActivityType, T[]>();
  for (const activity of REFLEX_ACTIVITY_TYPES) {
    const group = candidates
      .filter((candidate) => candidate.activityType === activity)
      .sort(
        (left, right) =>
          right.history.priority - left.history.priority || left.cardId.localeCompare(right.cardId),
      );
    if (group.length > 0) groups.set(activity, group);
  }

  for (let pass = 0; selected.length < poolSize && pass < candidates.length; pass += 1) {
    for (const activity of REFLEX_ACTIVITY_TYPES) {
      const group = groups.get(activity);
      if (!group || selected.length >= poolSize) continue;
      const remaining = group.filter((candidate) => !used.has(candidate.cardId));
      if (remaining.length === 0) continue;
      const candidate =
        pass % 2 === 0
          ? remaining[0]!
          : [...remaining].sort(
              (left, right) =>
                stableHash(`${sessionId}\0${activity}\0${left.cardId}`) -
                  stableHash(`${sessionId}\0${activity}\0${right.cardId}`) ||
                left.cardId.localeCompare(right.cardId),
            )[0]!;
      used.add(candidate.cardId);
      selected.push(candidate);
    }
  }
  return selected;
}

export function selectNextReflexCard(
  cards: readonly ReflexCard[],
  answers: readonly ReflexAnswerRecord[],
  round: number,
): ReflexCard | null {
  if (cards.length === 0) return null;
  const recentIds = new Set(answers.slice(-2).map(({ cardId }) => cardId));
  const cooled = cards.filter((card) => !recentIds.has(card.cardId));
  const eligible = cooled.length > 0 ? cooled : [...cards];
  return [...eligible].sort((left, right) => {
    const scoreDifference = sessionPriority(right, answers) - sessionPriority(left, answers);
    if (scoreDifference !== 0) return scoreDifference;
    const hashDifference =
      stableHash(`${round}\0${left.cardId}`) - stableHash(`${round}\0${right.cardId}`);
    return hashDifference || left.cardId.localeCompare(right.cardId);
  })[0]!;
}

export function presentReflexQuestion(
  card: ReflexCard,
  sessionId: string,
  round: number,
  exposure: number,
): PresentedReflexQuestion {
  const base = [...card.choices].sort(
    (left, right) =>
      stableHash(`${sessionId}\0${card.cardId}\0${left.id}`) -
        stableHash(`${sessionId}\0${card.cardId}\0${right.id}`) || left.id.localeCompare(right.id),
  );
  const offset = exposure % base.length;
  return {
    presentationId: `${sessionId}:${round}:${card.cardId}`,
    round,
    card,
    choices: [...base.slice(offset), ...base.slice(0, offset)],
  };
}

export function parseReflexAttemptMetadata(
  value: unknown,
  compatibility: { legacyResponseMs?: number } = {},
): ReflexAttemptMetadata {
  const body = requiredRecord(value, "reflex attempt metadata");
  if (body.interaction !== REFLEX_INTERACTION) {
    throw new InvalidInputError("reflex attempts require the canonical interaction identity");
  }
  const promptHint = body.promptHint;
  if (promptHint !== null && typeof promptHint !== "string") {
    throw new InvalidInputError("reflex promptHint must be text or null");
  }
  const choiceCount = quizChoiceCount(body.choiceCount);
  if (!Array.isArray(body.options) || body.options.length !== choiceCount) {
    throw new InvalidInputError(`reflex attempts require exactly ${choiceCount} presented options`);
  }
  const options = body.options.map((option, index) => {
    const record = requiredRecord(option, "reflex option");
    const position = boundedInteger(record.position, "option position", 1, choiceCount);
    if (position !== index + 1) {
      throw new InvalidInputError("reflex option positions must preserve presentation order");
    }
    return {
      id: boundedText(record.id, "option id"),
      label: boundedText(record.label, "option label", 500),
      position,
    };
  });
  if (new Set(options.map(({ id }) => id)).size !== options.length) {
    throw new InvalidInputError("reflex option identities must be unique");
  }
  const legacyUninterruptedTiming =
    body.choiceCount === undefined &&
    body.timingInterrupted === undefined &&
    compatibility.legacyResponseMs !== undefined &&
    choiceCount === 4;
  return {
    interaction: REFLEX_INTERACTION,
    presentationId: boundedText(body.presentationId, "presentationId", 500),
    round: boundedInteger(body.round, "round", 1, MAX_REFLEX_SESSION_SIZE),
    prompt: boundedText(body.prompt, "prompt", 500),
    promptHint,
    answerChoiceId: boundedText(body.answerChoiceId, "answerChoiceId", 500),
    selectedChoiceId: boundedText(body.selectedChoiceId, "selectedChoiceId", 500),
    choiceCount,
    timingInterrupted: legacyUninterruptedTiming
      ? false
      : booleanField(body.timingInterrupted, "timingInterrupted"),
    options,
  };
}

function sessionPriority(card: ReflexCard, answers: readonly ReflexAnswerRecord[]): number {
  const own = answers.filter(({ cardId }) => cardId === card.cardId);
  const latest = own.at(-1);
  const unseenBonus = own.length === 0 ? 3 : 0;
  const currentTrouble = latest
    ? latest.correct
      ? latest.timingInterrupted || latest.responseMs === null
        ? 0
        : card.choices.length === 4 && latest.responseMs >= REFLEX_SLOW_RESPONSE_MS
          ? 4
          : -2
      : 8
    : 0;
  return card.history.priority + unseenBonus + currentTrouble - own.length * 1.5;
}

function quizActivity(value: unknown): QuizActivity {
  if (value === undefined || value === "mixed") return "mixed";
  if (isReflexActivity(value)) return value;
  throw new InvalidInputError("activityType must be mixed or a supported vocabulary quiz activity");
}

function quizChoiceCount(value: unknown): QuizChoiceCount {
  if (value === undefined || value === 4) return 4;
  if (value === 9) return 9;
  throw new InvalidInputError("choiceCount must be 4 or 9");
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new InvalidInputError(`${field} must be boolean`);
  return value;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new InvalidInputError(`${field} must be non-empty text of at most ${maximum} characters`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidInputError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}
