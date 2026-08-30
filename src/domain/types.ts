import type { FSRSParameters } from "ts-fsrs";
import type {
  NormalizedSyllable,
  PronunciationActivityType,
  PronunciationFocus,
  Tone,
} from "./pronunciation";

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

export interface PronunciationMedia {
  id: string;
  url: string;
  license: string;
  attribution: string;
}

export interface PronunciationChoice {
  id: string;
  label: string;
}

export interface PronunciationCard {
  cardId: string;
  readingId: string;
  activityType: PronunciationActivityType;
  lexeme: {
    simplified: string;
    traditional: string | null;
    meanings: string[];
    hskLevel: number | null;
  };
  reading: {
    pinyin: string;
    numericPinyin: string;
    untonedPinyin: string;
    syllables: NormalizedSyllable[];
    tone: Tone | null;
    tonePair: [Tone, Tone] | null;
  };
  media: PronunciationMedia | null;
  choices: PronunciationChoice[];
  answerChoiceId: string | null;
}

export interface PronunciationSessionView {
  id: string;
  deviceId: string;
  focus: PronunciationFocus;
  maxItems: number;
  completedItems: number;
  startedAt: number;
  endedAt: number | null;
}

export interface PronunciationNextResult {
  status: "card" | "empty" | "completed";
  session: PronunciationSessionView;
  card: PronunciationCard | null;
}

export interface OfflineStudyPack {
  status: "cards" | "empty" | "completed";
  session: StudySessionView;
  cards: StudyCard[];
}

export interface OfflinePronunciationPack {
  status: "cards" | "empty" | "completed";
  session: PronunciationSessionView;
  cards: PronunciationCard[];
}

export interface SyncAttemptChange {
  seq: number;
  entityType: "attempt";
  eventId: string;
  deviceId: string;
  deviceSeq: number;
  cardId: string;
  occurredAt: number;
  reviewCreated: boolean;
}

export interface SyncCardStateChange {
  seq: number;
  entityType: "card_state";
  cardState: MaterializedCardState;
}

export interface SyncSessionChange {
  seq: number;
  entityType: "study_session";
  sessionId: string;
  mode: "study" | "pronunciation";
  endedAt: number | null;
}

export interface SyncOtherLearnerChange {
  seq: number;
  entityType: "grammar_topic_state";
  entityId: string;
}

export type SyncLearnerChange =
  SyncAttemptChange | SyncCardStateChange | SyncSessionChange | SyncOtherLearnerChange;

export interface SyncContentChange {
  seq: number;
  entityId: string;
  operation: "upsert" | "delete";
  revision: number;
}

export interface SyncPullResponse {
  nextCursor: number;
  hasMore: boolean;
  currentContentRevision: number | null;
  contentChanged: boolean;
  learnerChanges: SyncLearnerChange[];
  contentChanges: SyncContentChange[];
  studyPack: OfflineStudyPack | null;
  pronunciationPack: OfflinePronunciationPack | null;
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
