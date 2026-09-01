import { normalizeNumericPinyin } from "../domain/pronunciation";
import {
  BEGINNER_GRAMMAR_TOPICS,
  READING_GRAMMAR_SOURCE,
  READING_GRAMMAR_SOURCE_REF,
  type BeginnerGrammarTopic,
} from "../domain/reading-grammar";

export interface V1SourceForm {
  traditional?: string;
  transcriptions: {
    pinyin: string;
    numeric: string;
  };
  meanings: string[];
}

export interface V1SourceLexeme {
  simplified: string;
  frequency?: number;
  pos?: string[];
  forms: V1SourceForm[];
  hskLevel: number;
}

export interface V1Enrichment {
  simplified: string;
  meaning_ja?: string;
  example_zh?: string;
  example_pinyin?: string;
  example_en?: string;
  example_ja?: string;
}

export interface V1ImportInput {
  lexemes: V1SourceLexeme[];
  enrichments: V1Enrichment[];
  vocabularyVersion: string;
  v1Version: string;
  createdAt?: number;
}

const IMPORT_SOURCE = "complete-hsk-vocabulary + chinese-learning-v1-enrichment";

export interface V1ImportIdentity {
  contentDigest: string;
  sourceVersion: string;
  changeId: string;
}

export async function buildV1ImportSql(input: V1ImportInput): Promise<string> {
  return `${(await buildV1ImportStatements(input)).join("\n\n")}\n`;
}

export async function deriveV1ImportIdentity(input: V1ImportInput): Promise<V1ImportIdentity> {
  validateImportInput(input);
  const contentDigest = await sha256(canonicalImportedContent(input));
  return {
    contentDigest,
    sourceVersion:
      `complete-hsk-vocabulary@${input.vocabularyVersion};` +
      `v1@${input.v1Version};content-sha256:${contentDigest}`,
    changeId: `content-import:sha256:${contentDigest}`,
  };
}

export async function buildV1ImportStatements(input: V1ImportInput): Promise<string[]> {
  const identity = await deriveV1ImportIdentity(input);
  const createdAt = input.createdAt ?? 0;
  const revision = `(SELECT revision FROM content_revisions WHERE source = ${sqlText(
    IMPORT_SOURCE,
  )} AND source_version = ${sqlText(identity.sourceVersion)})`;
  const importAllowed = `NOT EXISTS (
    SELECT 1 FROM server_changes WHERE change_id = ${sqlText(identity.changeId)}
  )`;
  const enrichmentBySimplified = new Map(
    input.enrichments.map((enrichment) => [enrichment.simplified, enrichment]),
  );
  const selectedSimplified = new Set(input.lexemes.map((lexeme) => lexeme.simplified));
  const incompleteFoundationAnchors = new Set(
    BEGINNER_GRAMMAR_TOPICS.filter(
      (topic) =>
        selectedSimplified.has(topic.anchorSimplified) &&
        !topic.lexemes.every((link) => selectedSimplified.has(link.simplified)),
    ).map((topic) => topic.anchorSimplified),
  );
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT OR IGNORE INTO content_revisions
      (source, source_version, description, created_at)
     VALUES (
       ${sqlText(IMPORT_SOURCE)},
       ${sqlText(identity.sourceVersion)},
       ${sqlText(
         `HSK 2.0 vocabulary with v1 LLM enrichment; ${input.lexemes.length} lexemes; content sha256 ${identity.contentDigest}`,
       )},
       ${createdAt}
     );`,
  ];

  for (const level of [...new Set(input.lexemes.map((lexeme) => lexeme.hskLevel))].sort()) {
    statements.push(`INSERT INTO tags (id, kind, label, source, content_revision)
      SELECT
        ${sqlText(`tag:hsk-2.0:${level}`)},
        'hsk-2.0',
        ${sqlText(`level-${level}`)},
        'complete-hsk-vocabulary',
        ${revision}
      WHERE ${importAllowed}
      ON CONFLICT(kind, label) DO UPDATE SET
        source = excluded.source,
        content_revision = excluded.content_revision;`);
  }

  for (const lexeme of input.lexemes) {
    const lexemeId = `lexeme:complete-hsk:${encodeIdPart(lexeme.simplified)}`;
    const enrichment = enrichmentBySimplified.get(lexeme.simplified);
    const meanings = lexeme.forms.flatMap((form) =>
      form.meanings.map((text) => ({ language: "en", text })),
    );
    if (enrichment?.meaning_ja) {
      meanings.push({ language: "ja", text: enrichment.meaning_ja });
    }
    const preferredTraditional = lexeme.forms[0]?.traditional ?? lexeme.simplified;
    const readings = uniqueReadings(lexeme, lexemeId);
    const currentReadingIds = readings.map((reading) => sqlText(reading.id)).join(", ");
    const hskTagId = `(SELECT id FROM tags
      WHERE kind = 'hsk-2.0' AND label = ${sqlText(`level-${lexeme.hskLevel}`)})`;
    const sentenceId = `sentence:v1:${encodeIdPart(lexeme.simplified)}`;
    // A partial import may still keep the anchor's generic example on a fresh
    // database, but it cannot safely rewrite an active curated sentence graph
    // without all linked lexemes and exact readings present in this revision.
    const sentenceImportAllowed = incompleteFoundationAnchors.has(lexeme.simplified)
      ? `(${importAllowed}) AND NOT EXISTS (
          SELECT 1 FROM cards
          WHERE id = ${sqlText(`card:${sentenceId}:sentence_reading`)}
            AND retired_at IS NULL
        )`
      : importAllowed;

    statements.push(`INSERT INTO lexemes
      (id, simplified, traditional, meanings_json, pos_json, frequency_rank,
       source, source_ref, metadata_json, content_revision, created_at, updated_at)
     SELECT
       ${sqlText(lexemeId)},
       ${sqlText(lexeme.simplified)},
       ${sqlText(preferredTraditional)},
       ${sqlText(JSON.stringify(meanings))},
       ${sqlText(JSON.stringify(lexeme.pos ?? []))},
       ${sqlNumber(lexeme.frequency)},
       'complete-hsk-vocabulary',
       'https://github.com/drkameleon/complete-hsk-vocabulary',
       ${sqlText(JSON.stringify({ hskVersion: "2.0", hskLevel: lexeme.hskLevel }))},
       ${revision},
       ${createdAt},
       ${createdAt}
     WHERE ${importAllowed}
     ON CONFLICT(id) DO UPDATE SET
       simplified = excluded.simplified,
       traditional = excluded.traditional,
       meanings_json = excluded.meanings_json,
       pos_json = excluded.pos_json,
       frequency_rank = excluded.frequency_rank,
       source = excluded.source,
       source_ref = excluded.source_ref,
       metadata_json = excluded.metadata_json,
       content_revision = excluded.content_revision,
       updated_at = excluded.updated_at;`);

    for (const reading of readings) {
      statements.push(`INSERT INTO lexeme_readings
        (id, lexeme_id, pinyin, numeric_pinyin, normalized_syllables_json,
         is_preferred, form_scope, sense_scope, source, source_ref,
         metadata_json, content_revision, created_at, retired_at)
       SELECT
         ${sqlText(reading.id)},
         ${sqlText(lexemeId)},
         ${sqlText(reading.form.transcriptions.pinyin)},
         ${sqlText(reading.form.transcriptions.numeric)},
         ${sqlText(JSON.stringify(normalizeNumericPinyin(reading.form.transcriptions.numeric)))},
         0,
         ${sqlText(reading.form.traditional ?? lexeme.simplified)},
         ${sqlText(JSON.stringify(reading.form.meanings))},
         'complete-hsk-vocabulary',
         'https://github.com/drkameleon/complete-hsk-vocabulary',
         '{}',
         ${revision},
         ${createdAt},
         NULL
       WHERE ${importAllowed}
       ON CONFLICT(id) DO UPDATE SET
         pinyin = excluded.pinyin,
         numeric_pinyin = excluded.numeric_pinyin,
         normalized_syllables_json = excluded.normalized_syllables_json,
         form_scope = excluded.form_scope,
         sense_scope = excluded.sense_scope,
         source = excluded.source,
         source_ref = excluded.source_ref,
         content_revision = excluded.content_revision,
         retired_at = NULL;`);
    }

    statements.push(`UPDATE lexeme_readings
      SET is_preferred = 0
      WHERE lexeme_id = ${sqlText(lexemeId)}
        AND source = 'complete-hsk-vocabulary'
        AND retired_at IS NULL
        AND ${importAllowed};`);

    statements.push(`UPDATE lexeme_readings
      SET is_preferred = 1
      WHERE id = ${sqlText(readings[0]?.id)}
        AND ${importAllowed};`);

    statements.push(`UPDATE lexeme_readings
      SET
        is_preferred = 0,
        retired_at = MAX(created_at, ${createdAt}),
        content_revision = ${revision}
      WHERE lexeme_id = ${sqlText(lexemeId)}
        AND source = 'complete-hsk-vocabulary'
        AND id NOT IN (${currentReadingIds})
        AND ${importAllowed};`);

    statements.push(`DELETE FROM lexeme_tags
      WHERE lexeme_id = ${sqlText(lexemeId)}
        AND tag_id IN (
          SELECT id FROM tags
          WHERE kind = 'hsk-2.0'
            AND source = 'complete-hsk-vocabulary'
            AND id <> ${hskTagId}
        )
        AND ${importAllowed};`);

    statements.push(`INSERT INTO lexeme_tags (lexeme_id, tag_id, content_revision)
      SELECT
        ${sqlText(lexemeId)},
        ${hskTagId},
        ${revision}
      WHERE ${importAllowed}
      ON CONFLICT(lexeme_id, tag_id) DO UPDATE SET
        content_revision = excluded.content_revision;`);

    if (enrichment?.example_zh) {
      statements.push(`INSERT INTO sentences
        (id, chinese, pinyin, meaning_ja, meaning_en, source, source_ref,
         metadata_json, content_revision, created_at, retired_at)
       SELECT
         ${sqlText(sentenceId)},
         ${sqlText(enrichment.example_zh)},
         ${sqlText(enrichment.example_pinyin)},
         ${sqlText(enrichment.example_ja)},
         ${sqlText(enrichment.example_en)},
         'why-learn-languages-when-we-have-llms-lol',
         'https://github.com/amatouhake/why-learn-languages-when-we-have-llms-lol',
         ${sqlText(JSON.stringify({ generatedBy: "LLM", reviewStatus: "unreviewed" }))},
         ${revision},
         ${createdAt},
         NULL
       WHERE ${sentenceImportAllowed}
       ON CONFLICT(id) DO UPDATE SET
         chinese = excluded.chinese,
         pinyin = excluded.pinyin,
         meaning_ja = excluded.meaning_ja,
         meaning_en = excluded.meaning_en,
         metadata_json = excluded.metadata_json,
         content_revision = excluded.content_revision,
         retired_at = NULL;`);
      statements.push(`INSERT INTO sentence_lexemes
        (sentence_id, lexeme_id, lexeme_reading_id, position, role, content_revision)
       SELECT
         ${sqlText(sentenceId)},
         ${sqlText(lexemeId)},
         ${sqlText(readings[0]?.id)},
         0,
         'target',
         ${revision}
       WHERE ${sentenceImportAllowed}
       ON CONFLICT(sentence_id, lexeme_id, position) DO UPDATE SET
         lexeme_reading_id = excluded.lexeme_reading_id,
         role = excluded.role,
         content_revision = excluded.content_revision;`);
    } else {
      statements.push(`DELETE FROM sentence_lexemes
        WHERE sentence_id = ${sqlText(sentenceId)}
          AND EXISTS (
            SELECT 1 FROM sentences
            WHERE id = ${sqlText(sentenceId)}
              AND source = 'why-learn-languages-when-we-have-llms-lol'
          )
          AND ${sentenceImportAllowed};`);
      statements.push(`DELETE FROM sentence_grammar_topics
        WHERE sentence_id = ${sqlText(sentenceId)}
          AND EXISTS (
            SELECT 1 FROM sentences
            WHERE id = ${sqlText(sentenceId)}
              AND source = 'why-learn-languages-when-we-have-llms-lol'
          )
          AND ${sentenceImportAllowed};`);
      statements.push(`UPDATE sentences
        SET
          retired_at = MAX(created_at, ${createdAt}),
          content_revision = ${revision}
        WHERE id = ${sqlText(sentenceId)}
          AND source = 'why-learn-languages-when-we-have-llms-lol'
          AND ${sentenceImportAllowed};`);
    }

    for (const activityType of ["hanzi_to_meaning", "meaning_to_hanzi"] as const) {
      const cardId = `card:${lexemeId}:${activityType}`;
      statements.push(`INSERT INTO cards
        (id, subject_type, lexeme_id, activity_type, scheduler_eligible,
         content_revision, created_at)
       SELECT
         ${sqlText(cardId)},
         'lexeme',
         ${sqlText(lexemeId)},
         ${sqlText(activityType)},
         1,
         ${revision},
         ${createdAt}
       WHERE ${importAllowed}
       ON CONFLICT(id) DO UPDATE SET
         content_revision = excluded.content_revision,
         retired_at = NULL;`);
      statements.push(`INSERT OR IGNORE INTO card_state
        (learner_id, card_id, due_at, rebuilt_at)
       SELECT learners.id, ${sqlText(cardId)}, ${createdAt}, ${createdAt}
       FROM learners
       WHERE ${importAllowed};`);
    }
  }

  statements.push(
    ...buildReadingGrammarStatements(
      input,
      revision,
      importAllowed,
      identity.contentDigest,
      createdAt,
    ),
  );

  statements.push(`UPDATE content_state
    SET current_content_revision = ${revision}, updated_at = ${createdAt}
    WHERE singleton = 1
      AND ${importAllowed};`);
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

function canonicalImportedContent(input: V1ImportInput): string {
  const selectedLexemes = new Set(input.lexemes.map((lexeme) => lexeme.simplified));
  const lexemes = input.lexemes
    .map((lexeme) => ({
      simplified: lexeme.simplified,
      frequency: lexeme.frequency,
      pos: lexeme.pos,
      hskLevel: lexeme.hskLevel,
      forms: lexeme.forms.map((form) => ({
        traditional: form.traditional,
        transcriptions: {
          pinyin: form.transcriptions.pinyin,
          numeric: form.transcriptions.numeric,
        },
        meanings: form.meanings,
      })),
    }))
    .sort((left, right) => compareCanonicalJson(left, right));
  const enrichments = input.enrichments
    .filter((enrichment) => selectedLexemes.has(enrichment.simplified))
    .map((enrichment) => ({
      simplified: enrichment.simplified,
      meaning_ja: enrichment.meaning_ja,
      example_zh: enrichment.example_zh,
      example_pinyin: enrichment.example_pinyin,
      example_en: enrichment.example_en,
      example_ja: enrichment.example_ja,
    }))
    .sort((left, right) => compareCanonicalJson(left, right));

  return canonicalJson({
    vocabularyVersion: input.vocabularyVersion,
    v1Version: input.v1Version,
    lexemes,
    enrichments,
    readingGrammarFoundation: BEGINNER_GRAMMAR_TOPICS,
  });
}

function buildReadingGrammarStatements(
  input: V1ImportInput,
  revision: string,
  importAllowed: string,
  contentDigest: string,
  createdAt: number,
): string[] {
  const lexemeBySimplified = new Map(input.lexemes.map((lexeme) => [lexeme.simplified, lexeme]));
  const enrichmentBySimplified = new Map(
    input.enrichments.map((enrichment) => [enrichment.simplified, enrichment]),
  );
  const statements: string[] = [];

  for (const topic of BEGINNER_GRAMMAR_TOPICS) {
    const anchor = lexemeBySimplified.get(topic.anchorSimplified);
    if (!anchor) continue;
    if (!topic.lexemes.every((link) => lexemeBySimplified.has(link.simplified))) {
      // A level- or limit-scoped import can contain the anchor without all of
      // the sentence's vocabulary. Keep generic enrichment importable, but do
      // not activate a guided card whose exact-reading graph is incomplete.
      continue;
    }
    const enrichment = enrichmentBySimplified.get(topic.anchorSimplified);
    const sentenceId = `sentence:v1:${encodeIdPart(topic.anchorSimplified)}`;
    const sentenceCardId = `card:${sentenceId}:sentence_reading`;
    const grammarCardId = `card:${topic.id}:sentence_reading`;
    if (!enrichment?.example_zh) {
      statements.push(`UPDATE cards
        SET
          retired_at = MAX(created_at, ${createdAt}),
          content_revision = ${revision}
        WHERE id IN (${sqlText(sentenceCardId)}, ${sqlText(grammarCardId)})
          AND retired_at IS NULL
          AND ${importAllowed};`);
      continue;
    }
    assertCuratedSentence(topic, enrichment);

    statements.push(`UPDATE sentences
      SET metadata_json = ${sqlText(
        JSON.stringify({
          generatedBy: "LLM",
          reviewStatus: "curated-foundation",
          curatedBy: READING_GRAMMAR_SOURCE,
        }),
      )}
      WHERE id = ${sqlText(sentenceId)}
        AND retired_at IS NULL
        AND ${importAllowed};`);
    statements.push(`DELETE FROM sentence_lexemes
      WHERE sentence_id = ${sqlText(sentenceId)}
        AND ${importAllowed};`);

    for (const link of topic.lexemes) {
      const linkedLexeme = lexemeBySimplified.get(link.simplified);
      if (!linkedLexeme) {
        throw new Error(
          `curated sentence ${topic.expectedSentence.chinese} is missing lexeme ${link.simplified}`,
        );
      }
      const lexemeId = `lexeme:complete-hsk:${encodeIdPart(linkedLexeme.simplified)}`;
      const reading = selectCuratedReading(topic, linkedLexeme, lexemeId, link);
      statements.push(`INSERT INTO sentence_lexemes
        (sentence_id, lexeme_id, lexeme_reading_id, position, role, content_revision)
       SELECT
         ${sqlText(sentenceId)},
         ${sqlText(lexemeId)},
         ${sqlText(reading.id)},
         ${link.position},
         ${sqlText(link.role)},
         ${revision}
       WHERE ${importAllowed};`);
    }

    statements.push(`INSERT INTO grammar_topics
      (id, title, level, source, source_ref, teaching_metadata_json,
       content_revision, created_at)
     SELECT
       ${sqlText(topic.id)},
       ${sqlText(topic.title)},
       ${sqlText(topic.level)},
       ${sqlText(READING_GRAMMAR_SOURCE)},
       ${sqlText(READING_GRAMMAR_SOURCE_REF)},
       ${sqlText(JSON.stringify(topic.teaching))},
       ${revision},
       ${createdAt}
     WHERE ${importAllowed}
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       level = excluded.level,
       source = excluded.source,
       source_ref = excluded.source_ref,
       teaching_metadata_json = excluded.teaching_metadata_json,
       content_revision = excluded.content_revision;`);
    statements.push(`INSERT INTO sentence_grammar_topics
      (sentence_id, grammar_topic_id, content_revision)
     SELECT ${sqlText(sentenceId)}, ${sqlText(topic.id)}, ${revision}
     WHERE ${importAllowed}
     ON CONFLICT(sentence_id, grammar_topic_id) DO UPDATE SET
       content_revision = excluded.content_revision;`);
    // Do not gate this immutable snapshot on importAllowed. That lets an
    // existing installation backfill practice identities after the migration
    // by rerunning its already-applied deterministic import.
    statements.push(`INSERT OR IGNORE INTO grammar_practice_versions
      (id, grammar_topic_id, sentence_id, practice_json, content_revision, created_at)
     VALUES (
       ${sqlText(`grammar-practice:${topic.id}:sha256:${contentDigest}`)},
       ${sqlText(topic.id)},
       ${sqlText(sentenceId)},
       ${sqlText(JSON.stringify(topic.teaching.practice))},
       ${revision},
       ${createdAt}
     );`);
    statements.push(`INSERT INTO cards
      (id, subject_type, sentence_id, activity_type, scheduler_eligible,
       content_revision, created_at)
     SELECT
       ${sqlText(sentenceCardId)}, 'sentence', ${sqlText(sentenceId)},
       'sentence_reading', 0, ${revision}, ${createdAt}
     WHERE ${importAllowed}
     ON CONFLICT(id) DO UPDATE SET
       content_revision = excluded.content_revision,
       retired_at = NULL;`);
    statements.push(`INSERT INTO cards
      (id, subject_type, grammar_topic_id, activity_type, scheduler_eligible,
       content_revision, created_at)
     SELECT
       ${sqlText(grammarCardId)}, 'grammar_topic', ${sqlText(topic.id)},
       'sentence_reading', 0, ${revision}, ${createdAt}
     WHERE ${importAllowed}
     ON CONFLICT(id) DO UPDATE SET
       content_revision = excluded.content_revision,
       retired_at = NULL;`);
  }

  return statements;
}

function assertCuratedSentence(
  topic: BeginnerGrammarTopic,
  enrichment: V1Enrichment | undefined,
): asserts enrichment is V1Enrichment {
  const expected = topic.expectedSentence;
  if (
    enrichment?.example_zh !== expected.chinese ||
    enrichment.example_pinyin !== expected.pinyin ||
    enrichment.example_ja !== expected.meaningJa ||
    enrichment.example_en !== expected.meaningEn
  ) {
    throw new Error(
      `curated grammar sentence drifted for ${topic.id}; review the corpus before importing`,
    );
  }
}

function selectCuratedReading(
  topic: BeginnerGrammarTopic,
  lexeme: V1SourceLexeme,
  lexemeId: string,
  link: BeginnerGrammarTopic["lexemes"][number],
): { id: string; form: V1SourceForm } {
  const candidates = uniqueReadings(lexeme, lexemeId).filter(
    ({ form }) => form.transcriptions.numeric === link.numericPinyin,
  );
  const selected = link.senseIncludes
    ? candidates.find(({ form }) =>
        form.meanings.some((meaning) => meaning.toLowerCase().includes(link.senseIncludes!)),
      )
    : candidates[0];
  if (!selected) {
    throw new Error(
      `curated sentence ${topic.expectedSentence.chinese} has no exact reading ` +
        `${link.simplified}/${link.numericPinyin}`,
    );
  }
  return selected;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function compareCanonicalJson(left: unknown, right: unknown): number {
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

export function uniqueReadings(
  lexeme: V1SourceLexeme,
  lexemeId: string,
): Array<{ id: string; form: V1SourceForm }> {
  const seen = new Set<string>();
  const readings: Array<{ id: string; form: V1SourceForm }> = [];
  for (const form of lexeme.forms) {
    const identity = [
      form.traditional ?? lexeme.simplified,
      form.transcriptions.pinyin,
      form.transcriptions.numeric,
    ].join("\u001f");
    if (seen.has(identity)) continue;
    seen.add(identity);
    readings.push({
      id: `reading:${lexemeId}:${encodeIdPart(identity)}`,
      form,
    });
  }
  return readings;
}

function validateImportInput(input: V1ImportInput): void {
  if (!input.vocabularyVersion.trim() || !input.v1Version.trim()) {
    throw new Error("both source versions are required for provenance");
  }
  if (!Number.isSafeInteger(input.createdAt ?? 0) || (input.createdAt ?? 0) < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  const lexemeIdentities = new Set<string>();
  for (const lexeme of input.lexemes) {
    if (!lexeme.simplified.trim() || lexeme.forms.length === 0) {
      throw new Error("every source lexeme needs an identity and at least one reading form");
    }
    if (!Number.isInteger(lexeme.hskLevel) || lexeme.hskLevel < 1) {
      throw new Error("every source lexeme needs a positive HSK level");
    }
    if (lexemeIdentities.has(lexeme.simplified)) {
      throw new Error(`duplicate lexeme identity: ${lexeme.simplified}`);
    }
    lexemeIdentities.add(lexeme.simplified);
  }

  const enrichmentIdentities = new Set<string>();
  for (const enrichment of input.enrichments) {
    if (enrichmentIdentities.has(enrichment.simplified)) {
      throw new Error(`duplicate enrichment identity: ${enrichment.simplified}`);
    }
    enrichmentIdentities.add(enrichment.simplified);
  }
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value).replaceAll("'", "%27");
}

function sqlText(value: string | undefined): string {
  return value === undefined ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number | undefined): string {
  return value === undefined ? "NULL" : String(value);
}
