import type { FSRSParameters } from "ts-fsrs";

export const ACTIVITY_TYPES = [
  "hanzi_to_meaning",
  "meaning_to_hanzi",
  "hanzi_to_pinyin",
  "pinyin_to_hanzi",
  "audio_to_hanzi",
  "audio_to_meaning",
  "tone_identification",
  "tone_pair_identification",
  "pronunciation_production",
  "read_aloud",
  "sentence_reading",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const PRACTICE_MODES = ["study", "reflex", "pronunciation", "reading", "grammar"] as const;

export type PracticeMode = (typeof PRACTICE_MODES)[number];
export type FsrsRating = 1 | 2 | 3 | 4;

export interface FsrsReviewInput {
  rating: FsrsRating;
  schedulerConfigId: string;
}

export interface AttemptInput {
  eventId: string;
  deviceId: string;
  deviceSeq: number;
  occurredAt: string;
  cardId: string;
  studySessionId?: string;
  mode: PracticeMode;
  activityType: ActivityType;
  correct?: boolean;
  score?: number;
  selfRating?: number;
  responseMs?: number;
  expectedCardStateVersion?: number;
  metadata?: Record<string, unknown>;
  fsrsReview?: FsrsReviewInput;
}

export interface CanonicalFsrsReview {
  eventId: string;
  cardId: string;
  deviceId: string;
  deviceSeq: number;
  occurredAt: number;
  rating: FsrsRating;
  schedulerConfigId: string;
}

export interface SchedulerConfig {
  id: string;
  algorithm: string;
  implementation: string;
  implementationVersion: string;
  parameters: FSRSParameters;
  desiredRetention: number;
}

export interface FsrsCardProjection {
  dueAt: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReviewAt: number | null;
}

export interface MaterializedCardState extends FsrsCardProjection {
  cardId: string;
  version: number;
  serverSeq: number | null;
  rebuiltAt: number;
}

export interface IngestResult {
  disposition: "inserted" | "duplicate";
  eventId: string;
  attemptServerSeq: number;
  reviewCreated: boolean;
  cardState: MaterializedCardState | null;
}

export interface StudyMeaning {
  language: string;
  text: string;
}

export interface StudyExample {
  chinese: string;
  pinyin: string | null;
  meaningJa: string | null;
  meaningEn: string | null;
}

export interface StudyCard {
  cardId: string;
  activityType: "hanzi_to_meaning" | "meaning_to_hanzi";
  source: "due" | "new";
  schedulerConfigId: string;
  state: {
    dueAt: number;
    reps: number;
    lapses: number;
    version: number;
  };
  lexeme: {
    simplified: string;
    traditional: string | null;
    pinyin: string | null;
    numericPinyin: string | null;
    meanings: StudyMeaning[];
    hskLevel: number | null;
  };
  example: StudyExample | null;
}

export interface StudySessionView {
  id: string;
  deviceId: string;
  maxCards: number;
  reviewedCards: number;
  startedAt: number;
  endedAt: number | null;
}

export interface StudyNextResult {
  status: "card" | "empty" | "completed";
  session: StudySessionView;
  card: StudyCard | null;
}

export function isActivityType(value: unknown): value is ActivityType {
  return typeof value === "string" && (ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function isPracticeMode(value: unknown): value is PracticeMode {
  return typeof value === "string" && (PRACTICE_MODES as readonly string[]).includes(value);
}

export function isFsrsRating(value: unknown): value is FsrsRating {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4;
}
