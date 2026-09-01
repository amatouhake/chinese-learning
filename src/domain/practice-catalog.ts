import type { PracticeMode } from "./types";

export type LearnerPracticeId =
  "vocabulary_review" | "vocabulary_quiz" | "pronunciation" | "reading" | "grammar";

export interface PracticeCatalogEntry {
  id: LearnerPracticeId;
  learnerName: string;
  mode: PracticeMode;
  purpose: string;
  interaction: string;
  evidence: readonly string[];
  doesNotMeasure: readonly string[];
  affectsFsrs: boolean;
  configuration: readonly string[];
  resultMetrics: readonly string[];
  useWhen: string;
  setupDescription: string;
}

/**
 * Product-semantic authority for learner-facing practice. Keep setup copy and
 * developer documentation aligned with this catalog; active drills should only
 * show the compact interaction instruction they need.
 */
export const PRACTICE_CATALOG = {
  vocabulary_review: {
    id: "vocabulary_review",
    learnerName: "単語・復習",
    mode: "study",
    purpose: "忘れかけた単語を、適切なタイミングで思い出して長く保つ。",
    interaction: "答えを自由に思い出してから表示し、思い出し方を4段階で記録する。",
    evidence: ["復習方向", "期限切れ/新規の出所", "FSRS評価", "完了カード"],
    doesNotMeasure: ["選択肢からの正答率", "反応速度による自動性"],
    affectsFsrs: true,
    configuration: ["出題方向", "希望枚数"],
    resultMetrics: ["完了枚数", "方向内訳", "評価分布", "忘れた/あやふやな単語"],
    useWhen: "毎日の復習を進めたいとき。期限の来たカードが新しいカードより先に出る。",
    setupDescription: "答えを見る前に思い出し、忘れにくい間隔へ整えます。",
  },
  vocabulary_quiz: {
    id: "vocabulary_quiz",
    learnerName: "単語・クイズ",
    mode: "reflex",
    purpose: "一度学んだ単語を、選択肢から速く正確に見分けられるようにする。",
    interaction: "4択または9択から客観的な答えを選び、その場で正誤を確認する。",
    evidence: ["出題方向", "選択肢数", "正誤", "中断されていない反応時間"],
    doesNotMeasure: ["自由再生", "長期保持", "9択であっても真の自由想起"],
    affectsFsrs: false,
    configuration: ["出題方向または混合", "4択/9択", "問題数", "選定方針"],
    resultMetrics: ["正解数", "有効な平均反応時間", "誤答/遅い単語", "同条件の最近の推移"],
    useWhen: "復習で触れた単語の認識や取り出しを滑らかにしたいとき。",
    setupDescription: "覚えた単語を選択肢から見分け、取り出す速さを整えます。",
  },
  pronunciation: {
    id: "pronunciation",
    learnerName: "発音",
    mode: "pronunciation",
    purpose: "ピンイン、声調、聞き取り、発音を活動ごとに確かめる。",
    interaction: "客観選択、答えを見て自己確認、発音して自己評価を活動に応じて行う。",
    evidence: ["フォーカス", "活動", "客観正誤または自己評価", "完了項目"],
    doesNotMeasure: ["活動をまたいだ単一の発音点数", "録音音声の自動採点"],
    affectsFsrs: false,
    configuration: ["フォーカス", "問題数"],
    resultMetrics: ["完了数", "活動内訳", "客観正誤", "自己評価分布", "要確認項目"],
    useWhen: "読みと音を結び付けたい、声調を聞き分けたい、発音を自己確認したいとき。",
    setupDescription: "読み・声調・聞き取り・発音を、目的別に確かめます。",
  },
  reading: {
    id: "reading",
    learnerName: "読解",
    mode: "reading",
    purpose: "例文を段階的に読み、単語・読み・意味・文法を文脈の中で結び付ける。",
    interaction: "例文を読み、必要な手掛かりを段階的に開き、理解度を自己評価する。",
    evidence: ["完了文", "理解度の自己評価", "遭遇した文法トピック"],
    doesNotMeasure: ["客観問題がない例文の正答率", "読む速さを能力点として扱うこと"],
    affectsFsrs: false,
    configuration: ["文数"],
    resultMetrics: ["完了文数", "理解度分布", "文法トピック", "要確認の例文"],
    useWhen: "単語や文法を、短い中国語の文脈で理解したいとき。",
    setupDescription: "例文を段階的に読み、単語と文法を文脈でつなぎます。",
  },
  grammar: {
    id: "grammar",
    learnerName: "読解・文法",
    mode: "grammar",
    purpose: "文法トピックを例文と客観問題で理解し、自信度を更新する。",
    interaction: "解説と例文を読み、選択問題に答えた後で理解度を自己評価する。",
    evidence: ["文法トピック", "客観正誤", "理解度の自己評価", "完了項目"],
    doesNotMeasure: ["自由作文能力", "読解全体をまとめた合成点"],
    affectsFsrs: false,
    configuration: ["項目数", "任意のフォーカストピック"],
    resultMetrics: ["完了数", "客観正誤", "理解度分布", "要確認トピック"],
    useWhen: "文型の使い分けを例文と問題で確かめたいとき。",
    setupDescription: "文型を例文で理解し、短い問題で使い分けを確かめます。",
  },
} as const satisfies Record<LearnerPracticeId, PracticeCatalogEntry>;
