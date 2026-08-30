export const READING_GRAMMAR_SOURCE = "chinese-learning:reading-grammar-foundation";
export const READING_GRAMMAR_SOURCE_REF =
  "https://resources.allsetlearning.com/chinese/grammar/A1_grammar_points";

export interface CuratedSentenceLexeme {
  simplified: string;
  numericPinyin: string;
  senseIncludes?: string;
  position: number;
  role: "subject" | "grammar" | "verb" | "object" | "quantity" | "complement";
}

export interface GrammarChoice {
  id: string;
  label: string;
}

export interface GrammarTeachingMetadata {
  sequence: number;
  pattern: string;
  summaryJa: string;
  explanationJa: string;
  contrastJa: string;
  practice: {
    prompt: string;
    choices: GrammarChoice[];
    answerChoiceId: string;
    explanationJa: string;
  };
}

export type GrammarPracticeMetadata = GrammarTeachingMetadata["practice"];

export interface BeginnerGrammarTopic {
  id: string;
  title: string;
  level: "foundation-1";
  anchorSimplified: string;
  expectedSentence: {
    chinese: string;
    pinyin: string;
    meaningJa: string;
    meaningEn: string;
  };
  lexemes: CuratedSentenceLexeme[];
  teaching: GrammarTeachingMetadata;
}

export const BEGINNER_GRAMMAR_TOPICS: readonly BeginnerGrammarTopic[] = [
  {
    id: "grammar:foundation:shi-noun-link",
    title: "是：名詞と名詞を結ぶ",
    level: "foundation-1",
    anchorSimplified: "是",
    expectedSentence: {
      chinese: "我是学生。",
      pinyin: "Wǒ shì xuéshēng.",
      meaningJa: "私は学生です。",
      meaningEn: "I am a student.",
    },
    lexemes: [
      { simplified: "我", numericPinyin: "wo3", position: 0, role: "subject" },
      {
        simplified: "是",
        numericPinyin: "shi4",
        senseIncludes: "to be",
        position: 1,
        role: "grammar",
      },
      { simplified: "学生", numericPinyin: "xue2 sheng5", position: 2, role: "complement" },
    ],
    teaching: {
      sequence: 1,
      pattern: "A + 是 + B",
      summaryJa: "A が何者・何であるかを、名詞 B で示します。",
      explanationJa:
        "是 は人や物の身分・種類を結びます。日本語の「〜です」に見えても、形容詞をそのまま結ぶ語ではありません。",
      contrastJa: "「私は元気です」は 我很好 のように言い、通常は 我是很好 とは言いません。",
      practice: {
        prompt: "我___学生。",
        choices: [
          { id: "shi", label: "是" },
          { id: "you", label: "有" },
          { id: "zai", label: "在" },
        ],
        answerChoiceId: "shi",
        explanationJa: "学生は身分を表す名詞なので、我 + 是 + 学生 です。",
      },
    },
  },
  {
    id: "grammar:foundation:you-possession",
    title: "有：持っている・いる",
    level: "foundation-1",
    anchorSimplified: "有",
    expectedSentence: {
      chinese: "我有两个姐姐。",
      pinyin: "Wǒ yǒu liǎng ge jiějie.",
      meaningJa: "私には姉が二人います。",
      meaningEn: "I have two older sisters.",
    },
    lexemes: [
      { simplified: "我", numericPinyin: "wo3", position: 0, role: "subject" },
      { simplified: "有", numericPinyin: "you3", position: 1, role: "grammar" },
      { simplified: "两", numericPinyin: "liang3", position: 2, role: "quantity" },
      {
        simplified: "个",
        numericPinyin: "ge4",
        senseIncludes: "classifier",
        position: 3,
        role: "quantity",
      },
      { simplified: "姐姐", numericPinyin: "jie3 jie5", position: 4, role: "object" },
    ],
    teaching: {
      sequence: 2,
      pattern: "A + 有 + B",
      summaryJa: "A が B を持つ、または A に B がいることを表します。",
      explanationJa:
        "有 は所有と存在に使います。この文では家族関係を「持つ」形で表し、日本語では自然に「姉がいる」と訳せます。",
      contrastJa: "有 の否定は普通 不有 ではなく 没有 を使います。",
      practice: {
        prompt: "我___两个姐姐。",
        choices: [
          { id: "zai", label: "在" },
          { id: "shi", label: "是" },
          { id: "you", label: "有" },
        ],
        answerChoiceId: "you",
        explanationJa: "家族が「いる／ある」という所有関係なので 有 を使います。",
      },
    },
  },
  {
    id: "grammar:foundation:zai-location",
    title: "在：場所にいる・ある",
    level: "foundation-1",
    anchorSimplified: "在",
    expectedSentence: {
      chinese: "我在家。",
      pinyin: "Wǒ zài jiā.",
      meaningJa: "家にいます。",
      meaningEn: "I'm at home.",
    },
    lexemes: [
      { simplified: "我", numericPinyin: "wo3", position: 0, role: "subject" },
      { simplified: "在", numericPinyin: "zai4", position: 1, role: "grammar" },
      {
        simplified: "家",
        numericPinyin: "jia1",
        position: 2,
        role: "complement",
      },
    ],
    teaching: {
      sequence: 3,
      pattern: "人・物 + 在 + 場所",
      summaryJa: "人や物がどこにいる・あるかを示します。",
      explanationJa:
        "場所を述べる 在 は主語の後、場所の前に置きます。短い文では「主語 + 在 + 場所」だけで成立します。",
      contrastJa: "有 は「ある／持つもの」を導き、在 は主語の所在地を示します。",
      practice: {
        prompt: "我___家。",
        choices: [
          { id: "you", label: "有" },
          { id: "zai", label: "在" },
          { id: "shi", label: "是" },
        ],
        answerChoiceId: "zai",
        explanationJa: "我 の所在地が 家 なので、主語 + 在 + 場所 の形です。",
      },
    },
  },
  {
    id: "grammar:foundation:bu-negation",
    title: "不：習慣・意志・状態の否定",
    level: "foundation-1",
    anchorSimplified: "不",
    expectedSentence: {
      chinese: "我不喝咖啡。",
      pinyin: "Wǒ bù hē kāfēi.",
      meaningJa: "私はコーヒーを飲みません。",
      meaningEn: "I don't drink coffee.",
    },
    lexemes: [
      { simplified: "我", numericPinyin: "wo3", position: 0, role: "subject" },
      { simplified: "不", numericPinyin: "bu4", position: 1, role: "grammar" },
      {
        simplified: "喝",
        numericPinyin: "he1",
        senseIncludes: "to drink",
        position: 2,
        role: "verb",
      },
      { simplified: "咖啡", numericPinyin: "ka1 fei1", position: 3, role: "object" },
    ],
    teaching: {
      sequence: 4,
      pattern: "不 + 動詞／形容詞",
      summaryJa: "現在・未来の習慣、意志、一般的な状態を否定します。",
      explanationJa:
        "不 は否定したい動詞や形容詞の直前に置きます。この文は一度の過去ではなく、コーヒーを飲まない習慣・選択を表します。",
      contrastJa: "完了した過去や「持っていない」は、基本的に 没／没有 の領域です。",
      practice: {
        prompt: "我___喝咖啡。",
        choices: [
          { id: "ma", label: "吗" },
          { id: "bu", label: "不" },
          { id: "you", label: "有" },
        ],
        answerChoiceId: "bu",
        explanationJa: "習慣として「飲まない」ので、動詞 喝 の前に 不 を置きます。",
      },
    },
  },
  {
    id: "grammar:foundation:ma-question",
    title: "吗：はい／いいえで答える疑問文",
    level: "foundation-1",
    anchorSimplified: "吗",
    expectedSentence: {
      chinese: "你好吗？",
      pinyin: "Nǐ hǎo ma?",
      meaningJa: "お元気ですか？",
      meaningEn: "How are you?",
    },
    lexemes: [
      { simplified: "你", numericPinyin: "ni3", position: 0, role: "subject" },
      { simplified: "好", numericPinyin: "hao3", position: 1, role: "complement" },
      {
        simplified: "吗",
        numericPinyin: "ma5",
        senseIncludes: "yes-no",
        position: 2,
        role: "grammar",
      },
    ],
    teaching: {
      sequence: 5,
      pattern: "平叙文 + 吗？",
      summaryJa: "文末に 吗 を加え、肯定か否定で答える質問にします。",
      explanationJa:
        "語順を大きく変えず、文末に軽く発音する 吗 を置きます。答えは動詞・形容詞を繰り返すか、その否定形で返せます。",
      contrastJa: "谁・什么・哪 など疑問語がすでにある質問には、通常さらに 吗 を足しません。",
      practice: {
        prompt: "你好___？",
        choices: [
          { id: "shenme", label: "什么" },
          { id: "ma", label: "吗" },
          { id: "shui", label: "谁" },
        ],
        answerChoiceId: "ma",
        explanationJa: "「元気ですか」と肯定・否定をたずねるので、文末に 吗 を置きます。",
      },
    },
  },
] as const;

export function parseGrammarTeachingMetadata(json: string): GrammarTeachingMetadata {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted grammar teaching metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  const practice = record.practice;
  if (
    !Number.isSafeInteger(record.sequence) ||
    typeof record.pattern !== "string" ||
    typeof record.summaryJa !== "string" ||
    typeof record.explanationJa !== "string" ||
    typeof record.contrastJa !== "string" ||
    !isGrammarPracticeMetadata(practice)
  ) {
    throw new Error("persisted grammar teaching metadata is invalid");
  }
  return value as GrammarTeachingMetadata;
}

export function parseGrammarPracticeMetadata(json: string): GrammarPracticeMetadata {
  const value: unknown = JSON.parse(json);
  if (!isGrammarPracticeMetadata(value)) {
    throw new Error("persisted grammar practice metadata is invalid");
  }
  return value;
}

function isGrammarPracticeMetadata(value: unknown): value is GrammarPracticeMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.prompt === "string" &&
    typeof record.answerChoiceId === "string" &&
    typeof record.explanationJa === "string" &&
    Array.isArray(record.choices) &&
    record.choices.every(
      (choice) =>
        typeof choice === "object" &&
        choice !== null &&
        !Array.isArray(choice) &&
        typeof (choice as Record<string, unknown>).id === "string" &&
        typeof (choice as Record<string, unknown>).label === "string",
    ) &&
    record.choices.some(
      (choice) => (choice as Record<string, unknown>).id === record.answerChoiceId,
    )
  );
}
