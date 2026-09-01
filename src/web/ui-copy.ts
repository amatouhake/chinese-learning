import type { ActivityType, PracticeMode, StudyDirection } from "../domain/types";
import type { PronunciationFocus } from "../domain/pronunciation";

export type Surface = "progress" | "study" | "reflex" | "pronunciation" | "reading";

export const SURFACE_OPTIONS: Array<{ value: Surface; label: string }> = [
  { value: "study", label: "単語" },
  { value: "pronunciation", label: "発音" },
  { value: "reading", label: "読解" },
  { value: "progress", label: "記録" },
];

export const PRACTICE_MODE_LABELS: Record<PracticeMode, string> = {
  study: "単語",
  reflex: "単語・クイズ",
  pronunciation: "発音",
  reading: "読解",
  grammar: "文法",
};

export const STUDY_DIRECTION_LABELS: Record<StudyDirection, string> = {
  mixed: "混合",
  hanzi_to_meaning: "漢字 → 日本語",
  meaning_to_hanzi: "日本語 → 漢字",
};

export const PRONUNCIATION_FOCUS_LABELS: Record<PronunciationFocus, string> = {
  mixed: "おまかせ",
  pinyin: "ピンイン",
  tones: "声調",
  listening: "聞き取り",
  speaking: "発話",
};

export function activityTypeLabel(activity: ActivityType): string {
  switch (activity) {
    case "hanzi_to_meaning":
      return "漢字 → 意味";
    case "meaning_to_hanzi":
      return "意味 → 漢字";
    case "hanzi_to_pinyin":
      return "漢字 → ピンイン";
    case "pinyin_to_hanzi":
      return "ピンイン → 漢字";
    case "audio_to_hanzi":
      return "音声 → 漢字";
    case "audio_to_meaning":
      return "音声 → 意味";
    case "tone_identification":
      return "声調を聞き分ける";
    case "tone_pair_identification":
      return "声調の組み合わせ";
    case "pronunciation_production":
      return "発音して確認";
    case "read_aloud":
      return "音読";
    case "sentence_reading":
      return "例文を読む";
  }
}

export function studyDirectionLabel(direction: StudyDirection): string {
  return STUDY_DIRECTION_LABELS[direction];
}

export function pronunciationFocusLabel(focus: PronunciationFocus): string {
  return PRONUNCIATION_FOCUS_LABELS[focus];
}

export function surfaceLabel(surface: Surface): string {
  if (surface === "reflex") return "単語";
  return SURFACE_OPTIONS.find((option) => option.value === surface)?.label ?? "学習";
}

export function learnerError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  const knownMessage = {
    "cached card changed in another tab; reload before answering":
      "このカードは別のタブで先に記録されました。再読み込みして続けてください。",
    "cached learning session changed in another tab; reload before answering":
      "この練習は別のタブで先に進みました。再読み込みして続けてください。",
    "study state changed in another tab; reload before answering this card":
      "学習の状態が別のタブで変わりました。再読み込みして続けてください。",
    "study state changed in another tab; reload before rating this card":
      "学習の状態が別のタブで変わりました。再読み込みして続けてください。",
    "Failed to fetch": "通信に失敗しました。接続を確認してもう一度試してください。",
    "NetworkError when attempting to fetch resource.":
      "通信に失敗しました。接続を確認してもう一度試してください。",
    "Offline storage is not ready.": "端末への保存を準備できませんでした。",
    "This browser cannot safely coordinate learning across tabs.":
      "このブラウザでは複数タブの学習を安全に同期できません。",
    "This browser cannot safely coordinate study identity across tabs.":
      "このブラウザでは複数タブの学習を安全に同期できません。",
  }[message];
  if (knownMessage) return knownMessage;
  if (!message) return fallback;
  if (message.startsWith("Request failed (")) {
    return "サーバーから正しく応答を受け取れませんでした。もう一度試してください。";
  }
  return message;
}
