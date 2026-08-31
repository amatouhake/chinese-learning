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

export type ReflexActivityType =
  "hanzi_to_meaning" | "meaning_to_hanzi" | "hanzi_to_pinyin" | "pinyin_to_hanzi";

export interface ReflexChoice {
  id: string;
  label: string;
}

export interface ReflexHistorySummary {
  attempts: number;
  incorrect: number;
  slow: number;
  averageResponseMs: number | null;
  lastTroubleAt: number | null;
  priority: number;
}

export interface ReflexCard {
  cardId: string;
  lexemeId: string;
  readingId: string | null;
  activityType: ReflexActivityType;
  prompt: string;
  promptHint: string | null;
  answerChoiceId: string;
  choices: ReflexChoice[];
  history: ReflexHistorySummary;
}

export interface ReflexSessionView {
  id: string;
  deviceId: string;
  maxItems: number;
  completedItems: number;
  poolSize: number;
  startedAt: number;
  endedAt: number | null;
}

export interface ReflexAnswerRecord {
  eventId: string;
  cardId: string;
  correct: boolean;
  responseMs: number;
  round: number;
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

export interface GrammarTopicStateView {
  grammarTopicId: string;
  status: "introduced" | "learning" | "comfortable" | null;
  introducedAt: number | null;
  lastStudiedAt: number | null;
  selfConfidence: number | null;
  version: number;
  serverSeq: number | null;
}

export interface ReadingVocabularyHint {
  lexemeId: string;
  readingId: string;
  simplified: string;
  traditional: string | null;
  pinyin: string;
  numericPinyin: string;
  meanings: StudyMeaning[];
  position: number;
  role: string | null;
}

export interface ReadingGrammarTopic {
  id: string;
  title: string;
  level: string | null;
  pattern: string;
  summaryJa: string;
  explanationJa: string;
  contrastJa: string;
  state: GrammarTopicStateView | null;
}

export interface ReadingCard {
  cardId: string;
  sentenceId: string;
  activityType: "sentence_reading";
  sentence: {
    chinese: string;
    pinyin: string;
    meaningJa: string;
    meaningEn: string;
    source: string;
    sourceRef: string | null;
  };
  vocabulary: ReadingVocabularyHint[];
  grammarTopics: ReadingGrammarTopic[];
}

export interface GrammarPractice {
  prompt: string;
  choices: Array<{ id: string; label: string }>;
  answerChoiceId: string;
  explanationJa: string;
}

export interface GrammarCard {
  cardId: string;
  topicId: string;
  practiceVersionId: string;
  practiceSentenceId: string;
  activityType: "sentence_reading";
  topic: ReadingGrammarTopic & {
    sequence: number;
    practice: GrammarPractice;
  };
  examples: Array<{
    sentenceId: string;
    chinese: string;
    pinyin: string;
    meaningJa: string;
    meaningEn: string;
  }>;
}

export interface GuidedSessionView {
  id: string;
  deviceId: string;
  mode: "reading" | "grammar";
  maxItems: number;
  completedItems: number;
  focusTopicId: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface ReadingNextResult {
  status: "card" | "empty" | "completed";
  session: GuidedSessionView;
  card: ReadingCard | null;
}

export interface GrammarNextResult {
  status: "card" | "empty" | "completed";
  session: GuidedSessionView;
  card: GrammarCard | null;
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

export interface OfflineReflexPack {
  status: "cards" | "empty" | "completed";
  session: ReflexSessionView;
  cards: ReflexCard[];
}

export interface OfflineReadingPack {
  status: "cards" | "empty" | "completed";
  session: GuidedSessionView;
  cards: ReadingCard[];
}

export interface OfflineGrammarPack {
  status: "cards" | "empty" | "completed";
  session: GuidedSessionView;
  cards: GrammarCard[];
}

export interface ProgressWindow {
  days: 7 | 30;
  attempts: number;
  answeredAttempts: number;
  scheduledReviews: number;
  activeDays: number;
  sessions: number;
  byMode: Record<PracticeMode, number>;
}

export interface ProgressCorrectness {
  responses: number;
  correct: number;
  rate: number | null;
}

export interface ProgressSelfRatings {
  responses: number;
  average: number | null;
  low: number;
  distribution: Record<FsrsRating, number>;
}

export interface ProgressTroubleItem {
  id: string;
  cardId: string;
  mode: PracticeMode;
  activityType: ActivityType;
  label: string;
  detail: string | null;
  recentAttempts: number;
  lastPracticedAt: number | null;
  reasons: string[];
  evidence: {
    errors?: number;
    slowResponses?: number;
    averageResponseMs?: number | null;
    selfRatings?: number;
    averageSelfRating?: number | null;
    fsrsRatings?: Record<FsrsRating, number>;
    lapses?: number;
    dueAt?: number;
  };
}

export interface PronunciationProgressActivity {
  activityType: PronunciationActivityType;
  responses: number;
  skips: number;
  distinctItems: number;
  correctness: ProgressCorrectness | null;
  selfRatings: ProgressSelfRatings | null;
  averageResponseMs: number | null;
  lastPracticedAt: number | null;
}

export interface ProgressSnapshot {
  snapshotVersion: 1;
  generatedAt: number;
  timezone: string;
  dataThrough: {
    serverSeq: number | null;
    changedAt: number | null;
    latestAttemptReceivedAt: number | null;
    latestAttemptOccurredAt: number | null;
  };
  overall: {
    last7Days: ProgressWindow;
    last30Days: ProgressWindow;
  };
  vocabulary: {
    totalScheduledCards: number;
    dueNow: number;
    new: number;
    learning: number;
    review: number;
    recentScheduledReviews: number;
    recentRatings: Record<FsrsRating, number>;
    lastReviewedAt: number | null;
    troublesomeCards: ProgressTroubleItem[];
  };
  pronunciation: {
    recentResponses: number;
    recentSkips: number;
    byActivity: PronunciationProgressActivity[];
    troublesomeItems: ProgressTroubleItem[];
  };
  reading: {
    recentResponses: number;
    recentSentences: number;
    comprehension: ProgressSelfRatings;
    lastPracticedAt: number | null;
    difficultSentences: ProgressTroubleItem[];
  };
  grammar: {
    topicCounts: {
      total: number;
      notIntroduced: number;
      introduced: number;
      learning: number;
      comfortable: number;
    };
    topics: Array<{
      id: string;
      title: string;
      status: "introduced" | "learning" | "comfortable" | null;
      confidence: number | null;
      lastStudiedAt: number | null;
    }>;
    recentResponses: number;
    correctness: ProgressCorrectness;
    confidence: ProgressSelfRatings;
    lastPracticedAt: number | null;
    troublesomeTopics: ProgressTroubleItem[];
  };
  reflex: {
    recentResponses: number;
    correctness: ProgressCorrectness;
    latency: {
      averageResponseMs: number | null;
      slowResponses: number;
      slowThresholdMs: number;
    };
    lastPracticedAt: number | null;
    troublesomeItems: ProgressTroubleItem[];
  };
  troublesomeItems: ProgressTroubleItem[];
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
  mode: "study" | "reflex" | "pronunciation" | "reading" | "grammar";
  endedAt: number | null;
}

export interface SyncOtherLearnerChange {
  seq: number;
  entityType: "grammar_topic_state";
  state: GrammarTopicStateView;
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
  reflexPack: OfflineReflexPack | null;
  pronunciationPack: OfflinePronunciationPack | null;
  readingPack: OfflineReadingPack | null;
  grammarPack: OfflineGrammarPack | null;
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
