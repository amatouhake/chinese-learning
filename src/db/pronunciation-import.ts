import {
  classifyWordAudioMapping,
  deriveTonePair,
  normalizeNumericPinyin,
  singleTone,
  type WordAudioMappingStatus,
} from "../domain/pronunciation";
import { uniqueReadings, type V1SourceLexeme } from "./v1-import";

const IMPORT_SOURCE = "chinese-learning pronunciation foundation";
const AUDIO_SOURCE = "audio-cmn";
const AUDIO_LICENSE = "CC-BY-SA";
const AUDIO_ATTRIBUTION = "Yue Tan; audio-cmn curation by Hugo Lopez and contributors";
const AUDIO_MAPPING_BASIS = "exact_hanzi_filename_single_active_reading";
const IMPORT_FORMAT = "pronunciation-foundation-v1";

export interface PronunciationAudioItem {
  simplified: string;
  status: WordAudioMappingStatus;
  sourcePath?: string;
  contentSha256?: string;
  byteLength?: number;
}

export interface PronunciationImportInput {
  lexemes: V1SourceLexeme[];
  vocabularyVersion: string;
  audioVersion: string;
  audioItems: PronunciationAudioItem[];
  createdAt?: number;
}

export interface PronunciationImportIdentity {
  contentDigest: string;
  sourceVersion: string;
  changeId: string;
}

export interface PronunciationCoverage {
  lexemes: number;
  readings: number;
  multiReadingLexemes: number;
  sourceFirstFormProperNames: number;
  completeToneReadings: number;
  singleToneReadings: number;
  tonePairReadings: number;
  audioReliable: number;
  audioAmbiguous: number;
  audioMissing: number;
  cards: number;
}

export async function buildPronunciationImportSql(
  input: PronunciationImportInput,
): Promise<string> {
  return `${(await buildPronunciationImportStatements(input)).join("\n\n")}\n`;
}

export async function derivePronunciationImportIdentity(
  input: PronunciationImportInput,
): Promise<PronunciationImportIdentity> {
  validateInput(input);
  const contentDigest = await sha256(canonicalJson(canonicalContent(input)));
  return {
    contentDigest,
    sourceVersion:
      `complete-hsk-vocabulary@${input.vocabularyVersion};` +
      `audio-cmn@${input.audioVersion};content-sha256:${contentDigest}`,
    changeId: `pronunciation-import:sha256:${contentDigest}`,
  };
}

export function pronunciationCoverage(input: PronunciationImportInput): PronunciationCoverage {
  validateInput(input);
  const audioBySimplified = new Map(input.audioItems.map((item) => [item.simplified, item]));
  let readings = 0;
  let multiReadingLexemes = 0;
  let sourceFirstFormProperNames = 0;
  let completeToneReadings = 0;
  let singleToneReadings = 0;
  let tonePairReadings = 0;
  let cards = 0;

  for (const lexeme of input.lexemes) {
    const lexemeReadings = uniqueReadings(lexeme, lexemeId(lexeme.simplified));
    readings += lexemeReadings.length;
    if (lexemeReadings.length > 1) multiReadingLexemes += 1;
    if (lexemeReadings.length > 1 && /^[A-Z]/u.test(lexeme.forms[0]?.transcriptions.pinyin ?? "")) {
      sourceFirstFormProperNames += 1;
    }
    const audio = audioBySimplified.get(lexeme.simplified);
    for (const reading of lexemeReadings) {
      const syllables = normalizeNumericPinyin(reading.form.transcriptions.numeric);
      const complete = syllables.length > 0 && syllables.every(({ tone }) => tone !== null);
      if (complete) completeToneReadings += 1;
      if (singleTone(syllables) !== null) singleToneReadings += 1;
      if (deriveTonePair(syllables) !== null) tonePairReadings += 1;
      cards += pronunciationActivities(syllables, audio?.status === "reliable").length;
    }
  }

  return {
    lexemes: input.lexemes.length,
    readings,
    multiReadingLexemes,
    sourceFirstFormProperNames,
    completeToneReadings,
    singleToneReadings,
    tonePairReadings,
    audioReliable: input.audioItems.filter(({ status }) => status === "reliable").length,
    audioAmbiguous: input.audioItems.filter(({ status }) => status === "ambiguous").length,
    audioMissing: input.audioItems.filter(({ status }) => status === "missing").length,
    cards,
  };
}

export async function buildPronunciationImportStatements(
  input: PronunciationImportInput,
): Promise<string[]> {
  const identity = await derivePronunciationImportIdentity(input);
  const coverage = pronunciationCoverage(input);
  const createdAt = input.createdAt ?? 0;
  const revision = `(SELECT revision FROM content_revisions WHERE source = ${sqlText(
    IMPORT_SOURCE,
  )} AND source_version = ${sqlText(identity.sourceVersion)})`;
  const importAllowed = `NOT EXISTS (
    SELECT 1 FROM server_changes WHERE change_id = ${sqlText(identity.changeId)}
  )`;
  const audioBySimplified = new Map(input.audioItems.map((item) => [item.simplified, item]));
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT OR IGNORE INTO content_revisions
      (source, source_version, description, created_at)
     VALUES (
       ${sqlText(IMPORT_SOURCE)},
       ${sqlText(identity.sourceVersion)},
       ${sqlText(
         `${coverage.readings} exact readings, ${coverage.cards} ordinary-practice cards, ` +
           `${coverage.audioReliable} reliable word recordings; content sha256 ${identity.contentDigest}`,
       )},
       ${createdAt}
     );`,
    `DELETE FROM lexeme_reading_media
      WHERE role = 'word_pronunciation'
        AND lexeme_reading_id IN (
          SELECT id FROM lexeme_readings WHERE retired_at IS NOT NULL
        )
        AND ${importAllowed};`,
    `UPDATE cards
      SET retired_at = MAX(created_at, ${createdAt}), content_revision = ${revision}
      WHERE subject_type = 'lexeme_reading'
        AND lexeme_reading_id IN (
          SELECT id FROM lexeme_readings WHERE retired_at IS NOT NULL
        )
        AND retired_at IS NULL
        AND ${importAllowed};`,
  ];

  for (const lexeme of input.lexemes) {
    const currentLexemeId = lexemeId(lexeme.simplified);
    const readings = uniqueReadings(lexeme, currentLexemeId);
    const audio = audioBySimplified.get(lexeme.simplified);

    for (const reading of readings) {
      const syllables = normalizeNumericPinyin(reading.form.transcriptions.numeric);
      const reliableAudio = audio?.status === "reliable" ? audio : null;
      const activities = pronunciationActivities(syllables, reliableAudio !== null);
      const currentCardIds = activities.map((activity) =>
        sqlText(`card:${reading.id}:${activity}`),
      );

      for (const activity of activities) {
        const cardId = `card:${reading.id}:${activity}`;
        statements.push(`INSERT INTO cards
          (id, subject_type, lexeme_reading_id, activity_type, scheduler_eligible,
           content_revision, created_at, retired_at)
         SELECT
           ${sqlText(cardId)},
           'lexeme_reading',
           ${sqlText(reading.id)},
           ${sqlText(activity)},
           0,
           ${revision},
           ${createdAt},
           NULL
         WHERE ${importAllowed}
         ON CONFLICT(id) DO UPDATE SET
           content_revision = excluded.content_revision,
           retired_at = NULL;`);
      }

      statements.push(`UPDATE cards
        SET retired_at = MAX(created_at, ${createdAt}), content_revision = ${revision}
        WHERE subject_type = 'lexeme_reading'
          AND lexeme_reading_id = ${sqlText(reading.id)}
          AND activity_type IN (
            'hanzi_to_pinyin', 'pinyin_to_hanzi', 'audio_to_hanzi', 'audio_to_meaning',
            'tone_identification', 'tone_pair_identification', 'pronunciation_production'
          )
          AND id NOT IN (${currentCardIds.join(", ")})
          AND ${importAllowed};`);

      if (reliableAudio) {
        const media = mediaIdentity(input.audioVersion, lexeme.simplified, reliableAudio);
        statements.push(`INSERT OR IGNORE INTO media_assets
          (id, media_type, source, source_version, source_path, content_sha256,
           byte_length, mime_type, license, attribution, delivery_key,
           metadata_json, content_revision, created_at)
         SELECT
           ${sqlText(media.id)},
           'audio',
           ${sqlText(AUDIO_SOURCE)},
           ${sqlText(input.audioVersion)},
           ${sqlText(requiredAudioField(reliableAudio.sourcePath, "sourcePath"))},
           ${sqlText(requiredAudioField(reliableAudio.contentSha256, "contentSha256"))},
           ${requiredAudioNumber(reliableAudio.byteLength)},
           'audio/mpeg',
           ${sqlText(AUDIO_LICENSE)},
           ${sqlText(AUDIO_ATTRIBUTION)},
           ${sqlText(media.deliveryKey)},
           ${sqlText(JSON.stringify({ quality: "64k", kind: "word" }))},
           ${revision},
           ${createdAt}
         WHERE ${importAllowed};`);
        statements.push(`INSERT INTO lexeme_reading_media
          (lexeme_reading_id, media_asset_id, role, mapping_basis, content_revision)
         SELECT
           ${sqlText(reading.id)},
           ${sqlText(media.id)},
           'word_pronunciation',
           ${sqlText(AUDIO_MAPPING_BASIS)},
           ${revision}
         WHERE ${importAllowed}
         ON CONFLICT(lexeme_reading_id, role) DO UPDATE SET
           media_asset_id = excluded.media_asset_id,
           mapping_basis = excluded.mapping_basis,
           content_revision = excluded.content_revision;`);
      } else {
        statements.push(`DELETE FROM lexeme_reading_media
          WHERE lexeme_reading_id = ${sqlText(reading.id)}
            AND role = 'word_pronunciation'
            AND ${importAllowed};`);
      }
    }
  }

  statements.push(`UPDATE learner_settings
    SET current_content_revision = ${revision}, updated_at = ${createdAt}
    WHERE singleton = 1 AND ${importAllowed};`);
  statements.push(`INSERT OR IGNORE INTO server_changes
    (change_id, entity_type, entity_id, operation, content_revision, changed_at)
   SELECT
     ${sqlText(identity.changeId)},
     'content',
     'content-revision:' || CAST(${revision} AS TEXT),
     'upsert',
     ${revision},
     ${createdAt}
   WHERE ${importAllowed};`);

  return statements;
}

export function mediaIdentity(
  audioVersion: string,
  simplified: string,
  audio: PronunciationAudioItem,
): { id: string; deliveryKey: string; url: string } {
  const digest = requiredAudioField(audio.contentSha256, "contentSha256");
  const hanziHex = bytesToHex(new TextEncoder().encode(simplified));
  const id = `media:audio-cmn:${audioVersion}:${hanziHex}:sha256:${digest}`;
  const deliveryKey = `audio-cmn/${audioVersion}/${hanziHex}-${digest}.mp3`;
  return { id, deliveryKey, url: `/media/${deliveryKey}` };
}

function pronunciationActivities(
  syllables: ReturnType<typeof normalizeNumericPinyin>,
  audio: boolean,
) {
  const activities = ["hanzi_to_pinyin", "pinyin_to_hanzi", "pronunciation_production"];
  if (singleTone(syllables) !== null) activities.push("tone_identification");
  if (deriveTonePair(syllables) !== null) activities.push("tone_pair_identification");
  if (audio) activities.push("audio_to_hanzi", "audio_to_meaning");
  return activities;
}

function validateInput(input: PronunciationImportInput): void {
  if (!input.vocabularyVersion.trim() || !input.audioVersion.trim()) {
    throw new Error("vocabulary and audio source versions are required");
  }
  if (!Number.isSafeInteger(input.createdAt ?? 0) || (input.createdAt ?? 0) < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  const lexemeNames = new Set<string>();
  for (const lexeme of input.lexemes) {
    if (!lexeme.simplified.trim() || lexeme.forms.length === 0) {
      throw new Error("every pronunciation lexeme needs at least one reading");
    }
    if (lexemeNames.has(lexeme.simplified)) {
      throw new Error(`duplicate pronunciation lexeme: ${lexeme.simplified}`);
    }
    lexemeNames.add(lexeme.simplified);
  }

  const itemNames = new Set<string>();
  for (const item of input.audioItems) {
    if (!lexemeNames.has(item.simplified) || itemNames.has(item.simplified)) {
      throw new Error(`invalid or duplicate audio mapping item: ${item.simplified}`);
    }
    itemNames.add(item.simplified);
    const readingCount = uniqueReadings(
      input.lexemes.find(({ simplified }) => simplified === item.simplified)!,
      lexemeId(item.simplified),
    ).length;
    const hasFile = item.sourcePath !== undefined;
    if (item.status !== classifyWordAudioMapping(hasFile, readingCount)) {
      throw new Error(`audio mapping status does not match source evidence: ${item.simplified}`);
    }
    if (hasFile) {
      if (!/^[0-9a-f]{64}$/u.test(item.contentSha256 ?? "")) {
        throw new Error(`audio content digest is invalid: ${item.simplified}`);
      }
      if (!Number.isSafeInteger(item.byteLength) || (item.byteLength ?? 0) <= 0) {
        throw new Error(`audio byte length is invalid: ${item.simplified}`);
      }
    }
  }
  if (itemNames.size !== lexemeNames.size) {
    throw new Error("every pronunciation lexeme needs an explicit audio mapping status");
  }
}

function canonicalContent(input: PronunciationImportInput): unknown {
  return {
    importFormat: IMPORT_FORMAT,
    pronunciationPolicy: {
      neutralTone: 5,
      tonePair: "exactly-two-complete-source-syllables",
      audioMappingBasis: AUDIO_MAPPING_BASIS,
    },
    audioSource: {
      name: AUDIO_SOURCE,
      license: AUDIO_LICENSE,
      attribution: AUDIO_ATTRIBUTION,
      mimeType: "audio/mpeg",
      quality: "64k",
    },
    vocabularyVersion: input.vocabularyVersion,
    audioVersion: input.audioVersion,
    lexemes: input.lexemes.map((lexeme) => ({
      simplified: lexeme.simplified,
      hskLevel: lexeme.hskLevel,
      frequency: lexeme.frequency,
      forms: lexeme.forms.map((form) => ({
        traditional: form.traditional,
        pinyin: form.transcriptions.pinyin,
        numericPinyin: form.transcriptions.numeric,
        meanings: form.meanings,
      })),
    })),
    audioItems: [...input.audioItems].sort((left, right) =>
      left.simplified.localeCompare(right.simplified),
    ),
  };
}

function lexemeId(simplified: string): string {
  return `lexeme:complete-hsk:${encodeURIComponent(simplified).replaceAll("'", "%27")}`;
}

function requiredAudioField(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`reliable audio is missing ${field}`);
  return value;
}

function requiredAudioNumber(value: number | undefined): number {
  if (value === undefined) throw new Error("reliable audio is missing byteLength");
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sortJson(record[key])]),
  );
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
