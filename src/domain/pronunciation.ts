import type { ActivityType } from "./types";

export const TONES = [1, 2, 3, 4, 5] as const;
export type Tone = (typeof TONES)[number];

export interface NormalizedSyllable {
  syllable: string;
  tone: Tone | null;
}

export const PRONUNCIATION_ACTIVITY_TYPES = [
  "hanzi_to_pinyin",
  "pinyin_to_hanzi",
  "audio_to_hanzi",
  "audio_to_meaning",
  "tone_identification",
  "tone_pair_identification",
  "pronunciation_production",
] as const satisfies readonly ActivityType[];

export type PronunciationActivityType = (typeof PRONUNCIATION_ACTIVITY_TYPES)[number];

export const PRONUNCIATION_FOCUSES = ["mixed", "pinyin", "tones", "listening", "speaking"] as const;

export type PronunciationFocus = (typeof PRONUNCIATION_FOCUSES)[number];

export const PRONUNCIATION_AUDIO_SKIP_INTERACTION = "skip-uncached-audio";
export const PRONUNCIATION_AUDIO_SKIP_REASON = "audio-not-cached";

export type WordAudioMappingStatus = "reliable" | "ambiguous" | "missing";

const PINYIN_SYLLABLES = new Set(
  `
    a ai an ang ao
    ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
    ca cai can cang cao ce cei cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo
    da dai dan dang dao de dei den deng di dian diao die ding diu dong dou du duan dui dun duo
    e ei en eng er
    fa fan fang fei fen feng fo fou fu
    ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo
    ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo
    ji jia jian jiang jiao jie jin jing jiong jiu ju jue juan jun
    ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo
    la lai lan lang lao le lei leng li lian liang liao lie lin ling liu long lou lu lv lve luan lun luo
    ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu
    na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nv nve nuo
    o ou
    pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu
    qi qia qian qiang qiao qie qin qing qiong qiu qu que quan qun
    ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo
    sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo
    ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo
    wa wai wan wang wei wen weng wo wu
    xi xia xian xiang xiao xie xin xing xiong xiu xu xue xuan xun
    ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun
    za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo
  `
    .split(/\s+/u)
    .filter(Boolean),
);

const TONE_MARKS = new Map<string, { base: string; tone: Tone }>([
  ["ā", { base: "a", tone: 1 }],
  ["á", { base: "a", tone: 2 }],
  ["ǎ", { base: "a", tone: 3 }],
  ["à", { base: "a", tone: 4 }],
  ["ē", { base: "e", tone: 1 }],
  ["é", { base: "e", tone: 2 }],
  ["ě", { base: "e", tone: 3 }],
  ["è", { base: "e", tone: 4 }],
  ["ī", { base: "i", tone: 1 }],
  ["í", { base: "i", tone: 2 }],
  ["ǐ", { base: "i", tone: 3 }],
  ["ì", { base: "i", tone: 4 }],
  ["ō", { base: "o", tone: 1 }],
  ["ó", { base: "o", tone: 2 }],
  ["ǒ", { base: "o", tone: 3 }],
  ["ò", { base: "o", tone: 4 }],
  ["ū", { base: "u", tone: 1 }],
  ["ú", { base: "u", tone: 2 }],
  ["ǔ", { base: "u", tone: 3 }],
  ["ù", { base: "u", tone: 4 }],
  ["ǖ", { base: "ü", tone: 1 }],
  ["ǘ", { base: "ü", tone: 2 }],
  ["ǚ", { base: "ü", tone: 3 }],
  ["ǜ", { base: "ü", tone: 4 }],
]);

export function normalizeNumericPinyin(numericPinyin: string): NormalizedSyllable[] {
  return numericPinyin
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .split(/[\s'’·-]+/u)
    .filter(Boolean)
    .map((token) => normalizeNumericSyllable(token));
}

/**
 * Normalize pinyin as it appears in source pronunciation metadata.
 *
 * Source collections commonly use compact tone-marked pinyin (for example
 * `dōngxi`) while the vocabulary importer stores numeric syllables. Compact
 * input is segmented against the explicit Mandarin syllable inventory above.
 * Compact input uses the shortest valid syllable sequence (the deliberate
 * maximal-syllable rule); ties fail closed instead of being guessed.
 */
export function normalizeSourcePinyin(sourcePinyin: string): NormalizedSyllable[] {
  const normalized = sourcePinyin.normalize("NFC").trim().toLowerCase();
  if (!normalized) throw new Error("pinyin pronunciation is empty");

  const tokens = normalized
    .replaceAll("u:", "ü")
    .split(/[\s'’ʼ＇·_-]+/u)
    .filter(Boolean);
  if (tokens.length === 0) throw new Error("pinyin pronunciation is empty");

  return tokens.flatMap((token) => {
    if (/[0-5]/u.test(token)) return normalizeNumericSourceToken(token);
    return normalizeToneMarkedToken(token);
  });
}

export function normalizedPinyinTokens(syllables: readonly NormalizedSyllable[]): string[] {
  return syllables.map(({ syllable, tone }) => `${syllable}${tone ?? ""}`);
}

/** Compare source evidence with a canonical reading without tone-sandhi rules. */
export function sameNormalizedPinyin(
  source: readonly NormalizedSyllable[],
  canonical: readonly NormalizedSyllable[],
): boolean {
  if (source.length !== canonical.length) return false;
  return source.every((sourceSyllable, index) => {
    const canonicalSyllable = canonical[index];
    if (!canonicalSyllable || sourceSyllable.syllable !== canonicalSyllable.syllable) return false;
    if (sourceSyllable.tone === 5) {
      return canonicalSyllable.tone === null || canonicalSyllable.tone === 5;
    }
    return sourceSyllable.tone === canonicalSyllable.tone;
  });
}

export function deriveTonePair(syllables: readonly NormalizedSyllable[]): [Tone, Tone] | null {
  if (syllables.length !== 2) return null;
  const [first, second] = syllables;
  if (first?.tone === null || first?.tone === undefined) return null;
  if (second?.tone === null || second?.tone === undefined) return null;
  return [first.tone, second.tone];
}

export function singleTone(syllables: readonly NormalizedSyllable[]): Tone | null {
  if (syllables.length !== 1) return null;
  return syllables[0]?.tone ?? null;
}

export function untonedPinyin(syllables: readonly NormalizedSyllable[]): string {
  return syllables.map(({ syllable }) => displaySyllable(syllable)).join(" ");
}

export function classifyWordAudioMapping(
  fileExists: boolean,
  activeReadingCount: number,
): WordAudioMappingStatus {
  if (!fileExists) return "missing";
  return activeReadingCount === 1 ? "reliable" : "ambiguous";
}

export function isPronunciationActivity(
  activityType: ActivityType,
): activityType is PronunciationActivityType {
  return (PRONUNCIATION_ACTIVITY_TYPES as readonly string[]).includes(activityType);
}

export function activitiesForFocus(focus: PronunciationFocus): PronunciationActivityType[] {
  switch (focus) {
    case "pinyin":
      return ["hanzi_to_pinyin", "pinyin_to_hanzi"];
    case "tones":
      return ["tone_identification", "tone_pair_identification"];
    case "listening":
      return ["audio_to_hanzi", "audio_to_meaning"];
    case "speaking":
      return ["pronunciation_production"];
    case "mixed":
      return [...PRONUNCIATION_ACTIVITY_TYPES];
  }
}

function normalizeNumericSyllable(token: string): NormalizedSyllable {
  const match = /^(.*?)([0-5])$/u.exec(token);
  if (!match) return { syllable: normalizeSyllableSpelling(token), tone: null };

  const rawTone = Number(match[2]);
  const tone = (rawTone === 0 ? 5 : rawTone) as Tone;
  return {
    syllable: normalizeSyllableSpelling(match[1] ?? token),
    tone,
  };
}

function normalizeNumericSourceToken(token: string): NormalizedSyllable[] {
  const syllables = normalizeNumericPinyin(token);
  if (syllables.length !== 1 || syllables[0]?.tone === null) {
    throw new Error(`unsupported numeric pinyin token: ${token}`);
  }
  assertKnownSyllable(syllables[0]?.syllable, token);
  return [{ syllable: syllables[0]!.syllable, tone: syllables[0]!.tone }];
}

function normalizeToneMarkedToken(token: string): NormalizedSyllable[] {
  const bases: string[] = [];
  const markedTones: Array<Tone | null> = [];
  for (const character of token) {
    const mark = TONE_MARKS.get(character);
    if (mark) {
      bases.push(mark.base);
      markedTones.push(mark.tone);
    } else {
      bases.push(character);
      markedTones.push(null);
    }
  }

  const base = normalizeSyllableSpelling(bases.join(""));
  const solutions = segmentToneMarkedToken(base, markedTones);
  if (solutions.length !== 1) {
    throw new Error(
      solutions.length === 0
        ? `unsupported tone-marked pinyin token: ${token}`
        : `ambiguous tone-marked pinyin token: ${token}`,
    );
  }
  return solutions[0]!;
}

function segmentToneMarkedToken(
  base: string,
  markedTones: readonly (Tone | null)[],
): NormalizedSyllable[][] {
  const solutions: NormalizedSyllable[][] = [];
  let shortestLength: number | undefined;
  const visit = (offset: number, current: NormalizedSyllable[]): void => {
    if (offset === base.length) {
      if (shortestLength === undefined || current.length < shortestLength) {
        shortestLength = current.length;
        solutions.length = 0;
        solutions.push(current);
      } else if (current.length === shortestLength && solutions.length < 2) {
        solutions.push(current);
      }
      return;
    }
    if (shortestLength !== undefined && current.length >= shortestLength) return;

    const candidates = [...PINYIN_SYLLABLES]
      .filter((syllable) => base.startsWith(syllable, offset))
      .sort((left, right) => right.length - left.length || left.localeCompare(right));
    for (const syllable of candidates) {
      const end = offset + syllable.length;
      const tones = markedTones.slice(offset, end).filter((tone) => tone !== null);
      if (tones.length > 1) continue;
      if (tones.length > 0 && !toneMarkIsInCanonicalPosition(syllable, markedTones, offset)) {
        continue;
      }
      const tone = tones[0] ?? 5;
      visit(end, [...current, { syllable, tone }]);
    }
  };
  visit(0, []);
  return solutions;
}

function toneMarkIsInCanonicalPosition(
  syllable: string,
  markedTones: readonly (Tone | null)[],
  offset: number,
): boolean {
  const toneOffset = markedTones
    .slice(offset, offset + syllable.length)
    .findIndex((value) => value !== null);
  if (toneOffset < 0) return true;
  const preferred = syllable.search(/[aeo]/u);
  const expected = preferred >= 0 ? preferred : lastVowelOffset(syllable);
  return toneOffset === expected;
}

function lastVowelOffset(syllable: string): number {
  for (let index = syllable.length - 1; index >= 0; index -= 1) {
    if (/[iuüv]/u.test(syllable[index] ?? "")) return index;
  }
  return 0;
}

function assertKnownSyllable(
  syllable: string | undefined,
  token: string,
): asserts syllable is string {
  if (!syllable || !PINYIN_SYLLABLES.has(syllable)) {
    throw new Error(`unsupported pinyin syllable: ${token}`);
  }
}

function normalizeSyllableSpelling(value: string): string {
  return value.replaceAll("u:", "v").replaceAll("ü", "v");
}

function displaySyllable(value: string): string {
  return value.replaceAll("v", "ü");
}
