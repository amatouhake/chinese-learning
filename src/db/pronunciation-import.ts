import {
  deriveTonePair,
  normalizeNumericPinyin,
  normalizeSourcePinyin,
  normalizedPinyinTokens,
  sameNormalizedPinyin,
  singleTone,
} from "../domain/pronunciation";
import { uniqueReadings, type V1SourceLexeme } from "./v1-import";

const IMPORT_SOURCE = "chinese-learning pronunciation foundation";
const AUDIO_SOURCE = "audio-cmn";
const AUDIO_LICENSE = "CC-BY-SA";
const AUDIO_ATTRIBUTION = "Yue Tan; audio-cmn curation by Hugo Lopez and contributors";
export const AUDIO_MAPPING_BASIS_SINGLE_READING =
  "exact_hanzi_filename_single_active_reading" as const;
export const AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION =
  "exact_source_pronunciation_active_reading" as const;
export const AUDIO_MAPPING_BASES = [
  AUDIO_MAPPING_BASIS_SINGLE_READING,
  AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
] as const;
const IMPORT_FORMAT = "pronunciation-foundation-v1";

export type PronunciationMappingBasis = (typeof AUDIO_MAPPING_BASES)[number];

export type PronunciationResolutionReason =
  | "no_matching_canonical_reading"
  | "multiple_canonical_rows_match"
  | "missing_source_pronunciation_metadata"
  | "conflicting_source_evidence"
  | "unsupported_normalization_case";

export interface PronunciationSourceEvidence {
  sourceText: string;
  sourcePronunciation: string;
  normalizedSourcePinyin: string[];
  metadataSourceId: string;
  metadataSourceDigest: string;
  metadataSourceRecordPath: string;
}

export interface PronunciationMetadataRecord {
  sourceText: string;
  sourcePronunciation: string;
  normalizedSourcePinyin: string[];
  sourcePath: string;
  sourceSection?: string;
}

export interface PronunciationMetadataSource {
  id: string;
  artifactSha256: string;
  snapshotSha256?: string;
  sourceName?: string;
  metadataUrl?: string;
  archiveUrl?: string;
  sourceReadmeUrl?: string;
  selectionRevision?: string;
  records: PronunciationMetadataRecord[];
}

export interface PronunciationAudioFile {
  sourcePath: string;
  contentSha256: string;
  byteLength: number;
}

interface PronunciationAudioFileItem extends PronunciationAudioFile {
  simplified: string;
}

export interface PronunciationReliableAudioItem extends PronunciationAudioFileItem {
  status: "reliable";
  targetReadingId: string;
  mappingBasis: PronunciationMappingBasis;
  sourceEvidence?: PronunciationSourceEvidence;
}

export interface PronunciationUnresolvedAudioItem extends PronunciationAudioFileItem {
  status: "ambiguous";
  resolutionReason?: PronunciationResolutionReason;
  sourceEvidence?: PronunciationSourceEvidence;
}

export interface PronunciationMissingAudioItem {
  simplified: string;
  status: "missing";
}

export type PronunciationAudioItem =
  PronunciationReliableAudioItem | PronunciationUnresolvedAudioItem | PronunciationMissingAudioItem;

export function resolvePronunciationAudioItem(
  lexeme: V1SourceLexeme,
  audioFile: PronunciationAudioFile | null,
  metadataSource?: PronunciationMetadataSource,
): PronunciationAudioItem {
  if (!audioFile) return { simplified: lexeme.simplified, status: "missing" };

  const readings = uniqueReadings(lexeme, lexemeId(lexeme.simplified));
  if (readings.length === 1) {
    return {
      simplified: lexeme.simplified,
      ...audioFile,
      status: "reliable",
      targetReadingId: readings[0]!.id,
      mappingBasis: AUDIO_MAPPING_BASIS_SINGLE_READING,
    };
  }

  const sourceRecord = metadataSource?.records.find(
    ({ sourceText }) => sourceText === lexeme.simplified,
  );
  if (!sourceRecord) {
    return {
      simplified: lexeme.simplified,
      ...audioFile,
      status: "ambiguous",
      resolutionReason: "missing_source_pronunciation_metadata",
    };
  }

  let normalizedSourcePinyin: string[];
  try {
    normalizedSourcePinyin = normalizedPinyinTokens(
      normalizeSourcePinyin(sourceRecord.sourcePronunciation),
    );
  } catch {
    return {
      simplified: lexeme.simplified,
      ...audioFile,
      status: "ambiguous",
      resolutionReason: sourceRecord.sourcePronunciation.trim()
        ? "unsupported_normalization_case"
        : "missing_source_pronunciation_metadata",
    };
  }
  if (!sameStringArray(normalizedSourcePinyin, sourceRecord.normalizedSourcePinyin)) {
    return {
      simplified: lexeme.simplified,
      ...audioFile,
      status: "ambiguous",
      resolutionReason: "conflicting_source_evidence",
    };
  }

  const sourceEvidence: PronunciationSourceEvidence = {
    sourceText: sourceRecord.sourceText,
    sourcePronunciation: sourceRecord.sourcePronunciation,
    normalizedSourcePinyin,
    metadataSourceId: metadataSource?.id ?? "",
    metadataSourceDigest: metadataSource?.artifactSha256 ?? "",
    metadataSourceRecordPath: sourceRecord.sourcePath,
  };
  const sourceSyllables = normalizeSourcePinyin(sourceRecord.sourcePronunciation);
  const matches = matchingCanonicalReadings(readings, sourceSyllables);
  if (matches.length === 1) {
    return {
      simplified: lexeme.simplified,
      ...audioFile,
      status: "reliable",
      targetReadingId: matches[0]!.id,
      mappingBasis: AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
      sourceEvidence,
    };
  }
  return {
    simplified: lexeme.simplified,
    ...audioFile,
    status: "ambiguous",
    resolutionReason:
      matches.length === 0 ? "no_matching_canonical_reading" : "multiple_canonical_rows_match",
    sourceEvidence,
  };
}

export interface PronunciationImportInput {
  lexemes: V1SourceLexeme[];
  vocabularyVersion: string;
  audioVersion: string;
  audioItems: PronunciationAudioItem[];
  metadataSource?: PronunciationMetadataSource;
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
  sourceAudioPresent: number;
  existingReliable: number;
  recoveredExact: number;
  totalReliable: number;
  stillAmbiguous: number;
  missing: number;
  pronunciationCards: number;
  audioCards: number;
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
  const metadataIdentity = metadataSourceIdentity(input.metadataSource);
  return {
    contentDigest,
    sourceVersion:
      `complete-hsk-vocabulary@${input.vocabularyVersion};` +
      `audio-cmn@${input.audioVersion};${metadataIdentity};content-sha256:${contentDigest}`,
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
  let pronunciationCards = 0;
  let audioCards = 0;

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
      const hasExactAudio = audio?.status === "reliable" && audio.targetReadingId === reading.id;
      const activities = pronunciationActivities(syllables, hasExactAudio);
      pronunciationCards += activities.length;
      if (hasExactAudio) audioCards += 2;
    }
  }

  const existingReliable = input.audioItems.filter(
    (item) =>
      item.status === "reliable" && item.mappingBasis === AUDIO_MAPPING_BASIS_SINGLE_READING,
  ).length;
  const recoveredExact = input.audioItems.filter(
    (item) =>
      item.status === "reliable" && item.mappingBasis === AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
  ).length;
  const totalReliable = existingReliable + recoveredExact;
  const stillAmbiguous = input.audioItems.filter(({ status }) => status === "ambiguous").length;
  const missing = input.audioItems.filter(({ status }) => status === "missing").length;

  return {
    lexemes: input.lexemes.length,
    readings,
    multiReadingLexemes,
    sourceFirstFormProperNames,
    completeToneReadings,
    singleToneReadings,
    tonePairReadings,
    sourceAudioPresent: totalReliable + stillAmbiguous,
    existingReliable,
    recoveredExact,
    totalReliable,
    stillAmbiguous,
    missing,
    pronunciationCards,
    audioCards,
    audioReliable: totalReliable,
    audioAmbiguous: stillAmbiguous,
    audioMissing: missing,
    cards: pronunciationCards,
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
           `${coverage.totalReliable} reliable word recordings; content sha256 ${identity.contentDigest}`,
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
      const reliableAudio =
        audio?.status === "reliable" && audio.targetReadingId === reading.id ? audio : null;
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
        const evidence = reliableAudio.sourceEvidence;
        statements.push(`INSERT INTO lexeme_reading_media
          (lexeme_reading_id, media_asset_id, role, mapping_basis,
           source_text, source_pronunciation, normalized_source_pinyin,
           metadata_source_id, metadata_source_digest, metadata_source_record_path,
           content_revision)
         SELECT
           ${sqlText(reading.id)},
           ${sqlText(media.id)},
           'word_pronunciation',
           ${sqlText(reliableAudio.mappingBasis)},
           ${sqlNullableText(evidence?.sourceText)},
           ${sqlNullableText(evidence?.sourcePronunciation)},
           ${sqlNullableText(
             evidence === undefined ? undefined : JSON.stringify(evidence.normalizedSourcePinyin),
           )},
           ${sqlNullableText(evidence?.metadataSourceId)},
           ${sqlNullableText(evidence?.metadataSourceDigest)},
           ${sqlNullableText(evidence?.metadataSourceRecordPath)},
           ${revision}
         WHERE ${importAllowed}
         ON CONFLICT(lexeme_reading_id, role) DO UPDATE SET
           media_asset_id = excluded.media_asset_id,
           mapping_basis = excluded.mapping_basis,
           source_text = excluded.source_text,
           source_pronunciation = excluded.source_pronunciation,
           normalized_source_pinyin = excluded.normalized_source_pinyin,
           metadata_source_id = excluded.metadata_source_id,
           metadata_source_digest = excluded.metadata_source_digest,
           metadata_source_record_path = excluded.metadata_source_record_path,
           content_revision = excluded.content_revision;`);
      } else {
        statements.push(`DELETE FROM lexeme_reading_media
          WHERE lexeme_reading_id = ${sqlText(reading.id)}
            AND role = 'word_pronunciation'
            AND ${importAllowed};`);
      }
    }
  }

  statements.push(`UPDATE content_state
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
  audio: PronunciationAudioFile,
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
  validateMetadataSource(input.metadataSource);
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
    const lexeme = input.lexemes.find(({ simplified }) => simplified === item.simplified)!;
    const readings = uniqueReadings(lexeme, lexemeId(item.simplified));
    if (item.status === "missing") continue;
    if (!item.sourcePath || !/^[0-9a-f]{64}$/u.test(item.contentSha256)) {
      throw new Error(`audio file evidence is invalid: ${item.simplified}`);
    }
    if (!Number.isSafeInteger(item.byteLength) || item.byteLength <= 0) {
      throw new Error(`audio byte length is invalid: ${item.simplified}`);
    }
    if (readings.length === 1 && item.status !== "reliable") {
      throw new Error(`audio mapping status does not match source evidence: ${item.simplified}`);
    }
    if (item.status === "reliable") {
      if (!readings.some(({ id }) => id === item.targetReadingId)) {
        throw new Error(`audio target reading is not active for ${item.simplified}`);
      }
      if (item.mappingBasis === AUDIO_MAPPING_BASIS_SINGLE_READING) {
        if (
          readings.length !== 1 ||
          item.targetReadingId !== readings[0]!.id ||
          item.sourceEvidence
        ) {
          throw new Error(`single-reading audio basis is invalid: ${item.simplified}`);
        }
      } else if (item.mappingBasis === AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION) {
        if (readings.length < 2) {
          throw new Error(
            `source-pronunciation audio basis needs multiple readings: ${item.simplified}`,
          );
        }
        const sourceSyllables = validateSourceEvidence(
          item.sourceEvidence,
          input.metadataSource,
          item.simplified,
        );
        const matches = matchingCanonicalReadings(readings, sourceSyllables);
        if (matches.length !== 1 || matches[0]?.id !== item.targetReadingId) {
          throw new Error(
            `source pronunciation does not uniquely resolve declared target reading: ${item.simplified}`,
          );
        }
      } else {
        throw new Error(`audio mapping basis is invalid: ${item.simplified}`);
      }
    } else if (item.sourceEvidence) {
      validateSourceEvidence(item.sourceEvidence, input.metadataSource, item.simplified);
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
      audioMappingBasis: [...AUDIO_MAPPING_BASES],
      exactReadingResolution: "one-active-lexeme-reading-matches-source-pronunciation",
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
    metadataSource: input.metadataSource
      ? {
          ...input.metadataSource,
          records: [...input.metadataSource.records].sort((left, right) =>
            compareStrings(left.sourceText, right.sourceText),
          ),
        }
      : null,
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
      compareStrings(left.simplified, right.simplified),
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

function sqlNullableText(value: string | undefined): string {
  return value === undefined ? "NULL" : sqlText(value);
}

function validateMetadataSource(source: PronunciationMetadataSource | undefined): void {
  if (!source) return;
  if (!source.id.trim() || !/^[0-9a-f]{64}$/u.test(source.artifactSha256)) {
    throw new Error("pronunciation metadata source identity is invalid");
  }
  if (source.snapshotSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(source.snapshotSha256)) {
    throw new Error("pronunciation metadata snapshot digest is invalid");
  }
  const texts = new Set<string>();
  for (const record of source.records) {
    if (
      !record.sourceText.trim() ||
      !record.sourcePath.trim() ||
      !record.sourcePronunciation.trim() ||
      record.normalizedSourcePinyin.length === 0 ||
      record.normalizedSourcePinyin.some((token) => !/^[a-zv]+[1-5]$/u.test(token))
    ) {
      throw new Error(`pronunciation metadata record is invalid: ${record.sourceText}`);
    }
    if (texts.has(record.sourceText)) {
      throw new Error(`duplicate pronunciation metadata record: ${record.sourceText}`);
    }
    let normalizedSourcePinyin: string[];
    try {
      normalizedSourcePinyin = normalizedPinyinTokens(
        normalizeSourcePinyin(record.sourcePronunciation),
      );
    } catch {
      throw new Error(`pronunciation metadata pinyin is unsupported: ${record.sourceText}`);
    }
    if (!sameStringArray(record.normalizedSourcePinyin, normalizedSourcePinyin)) {
      throw new Error(`pronunciation metadata pinyin evidence conflicts: ${record.sourceText}`);
    }
    texts.add(record.sourceText);
  }
}

function validateSourceEvidence(
  evidence: PronunciationSourceEvidence | undefined,
  metadataSource: PronunciationMetadataSource | undefined,
  simplified: string,
): ReturnType<typeof normalizeSourcePinyin> {
  if (!evidence || !metadataSource) {
    throw new Error(`exact source pronunciation evidence is missing: ${simplified}`);
  }
  if (
    evidence.sourceText !== simplified ||
    evidence.metadataSourceId !== metadataSource.id ||
    evidence.metadataSourceDigest !== metadataSource.artifactSha256 ||
    !evidence.sourcePronunciation.trim() ||
    !evidence.metadataSourceRecordPath.trim() ||
    evidence.normalizedSourcePinyin.length === 0 ||
    evidence.normalizedSourcePinyin.some((token) => !/^[a-zv]+[1-5]$/u.test(token))
  ) {
    throw new Error(`exact source pronunciation evidence is invalid: ${simplified}`);
  }
  const record = metadataSource.records.find(({ sourceText }) => sourceText === simplified);
  if (
    !record ||
    record.sourcePath !== evidence.metadataSourceRecordPath ||
    record.sourcePronunciation !== evidence.sourcePronunciation ||
    !sameStringArray(record.normalizedSourcePinyin, evidence.normalizedSourcePinyin)
  ) {
    throw new Error(`exact source pronunciation evidence does not match metadata: ${simplified}`);
  }
  let normalizedSourcePinyin: string[];
  try {
    normalizedSourcePinyin = normalizedPinyinTokens(
      normalizeSourcePinyin(evidence.sourcePronunciation),
    );
  } catch {
    throw new Error(`exact source pronunciation pinyin is unsupported: ${simplified}`);
  }
  if (!sameStringArray(evidence.normalizedSourcePinyin, normalizedSourcePinyin)) {
    throw new Error(`exact source pronunciation pinyin evidence conflicts: ${simplified}`);
  }
  return normalizeSourcePinyin(evidence.sourcePronunciation);
}

function matchingCanonicalReadings(
  readings: ReadonlyArray<{ id: string; form: V1SourceLexeme["forms"][number] }>,
  sourceSyllables: ReturnType<typeof normalizeSourcePinyin>,
): Array<{ id: string; form: V1SourceLexeme["forms"][number] }> {
  return readings.filter(({ form }) =>
    sameNormalizedPinyin(sourceSyllables, normalizeNumericPinyin(form.transcriptions.numeric)),
  );
}

function metadataSourceIdentity(source: PronunciationMetadataSource | undefined): string {
  if (!source) return "metadata-source@none";
  return (
    `metadata-source@${source.id};` +
    `metadata-artifact-sha256:${source.artifactSha256};` +
    `metadata-snapshot-sha256:${source.snapshotSha256 ?? "unspecified"}`
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
