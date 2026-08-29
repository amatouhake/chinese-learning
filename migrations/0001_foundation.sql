PRAGMA foreign_keys = ON;

CREATE TABLE content_revisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_version TEXT,
  description TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE server_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'attempt',
      'card_state',
      'content',
      'grammar_topic_state',
      'study_session'
    )
  ),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  content_revision INTEGER REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
  CHECK (entity_type <> 'content' OR content_revision IS NOT NULL)
) STRICT;

CREATE INDEX server_changes_pull_idx ON server_changes(seq, entity_type);

CREATE TABLE learner_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  current_content_revision INTEGER REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO learner_settings (singleton, timezone, updated_at)
VALUES (1, 'Asia/Tokyo', 0);

CREATE TABLE lexemes (
  id TEXT PRIMARY KEY,
  simplified TEXT NOT NULL CHECK (length(trim(simplified)) > 0),
  traditional TEXT,
  meanings_json TEXT NOT NULL CHECK (
    json_valid(meanings_json) AND json_type(meanings_json) = 'array'
  ),
  pos_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(pos_json) AND json_type(pos_json) = 'array'
  ),
  frequency_rank INTEGER CHECK (frequency_rank IS NULL OR frequency_rank > 0),
  source TEXT NOT NULL,
  source_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX lexemes_simplified_idx ON lexemes(simplified);
CREATE INDEX lexemes_traditional_idx ON lexemes(traditional) WHERE traditional IS NOT NULL;

CREATE TABLE lexeme_readings (
  id TEXT PRIMARY KEY,
  lexeme_id TEXT NOT NULL REFERENCES lexemes(id) ON DELETE RESTRICT,
  pinyin TEXT NOT NULL CHECK (length(trim(pinyin)) > 0),
  numeric_pinyin TEXT NOT NULL CHECK (length(trim(numeric_pinyin)) > 0),
  normalized_syllables_json TEXT NOT NULL CHECK (
    json_valid(normalized_syllables_json)
    AND json_type(normalized_syllables_json) = 'array'
  ),
  is_preferred INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0, 1)),
  form_scope TEXT,
  sense_scope TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (lexeme_id, id)
) STRICT;

CREATE UNIQUE INDEX lexeme_readings_one_preferred_idx
  ON lexeme_readings(lexeme_id)
  WHERE is_preferred = 1;
CREATE INDEX lexeme_readings_lexeme_idx ON lexeme_readings(lexeme_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT,
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  UNIQUE (kind, label)
) STRICT;

CREATE TABLE lexeme_tags (
  lexeme_id TEXT NOT NULL REFERENCES lexemes(id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  PRIMARY KEY (lexeme_id, tag_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE sentences (
  id TEXT PRIMARY KEY,
  chinese TEXT NOT NULL CHECK (length(trim(chinese)) > 0),
  pinyin TEXT,
  meaning_ja TEXT,
  meaning_en TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE sentence_lexemes (
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE RESTRICT,
  lexeme_id TEXT NOT NULL REFERENCES lexemes(id) ON DELETE RESTRICT,
  lexeme_reading_id TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  role TEXT,
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  PRIMARY KEY (sentence_id, lexeme_id, position),
  FOREIGN KEY (lexeme_id, lexeme_reading_id)
    REFERENCES lexeme_readings(lexeme_id, id)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE grammar_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  level TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  teaching_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(teaching_metadata_json)
    AND json_type(teaching_metadata_json) = 'object'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE sentence_grammar_topics (
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE RESTRICT,
  grammar_topic_id TEXT NOT NULL REFERENCES grammar_topics(id) ON DELETE RESTRICT,
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  PRIMARY KEY (sentence_id, grammar_topic_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE grammar_topic_state (
  grammar_topic_id TEXT PRIMARY KEY REFERENCES grammar_topics(id) ON DELETE RESTRICT,
  status TEXT CHECK (status IS NULL OR status IN ('introduced', 'learning', 'comfortable')),
  introduced_at INTEGER CHECK (introduced_at IS NULL OR introduced_at >= 0),
  last_studied_at INTEGER CHECK (last_studied_at IS NULL OR last_studied_at >= 0),
  self_confidence REAL CHECK (
    self_confidence IS NULL OR (self_confidence >= 0 AND self_confidence <= 1)
  ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  server_seq INTEGER UNIQUE REFERENCES server_changes(seq) ON DELETE RESTRICT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  )
) STRICT;

CREATE TABLE activity_types (
  id TEXT PRIMARY KEY,
  modality TEXT NOT NULL CHECK (modality IN ('perception', 'production', 'mixed')),
  can_be_scheduled INTEGER NOT NULL DEFAULT 1 CHECK (can_be_scheduled IN (0, 1))
) STRICT;

INSERT INTO activity_types (id, modality) VALUES
  ('hanzi_to_meaning', 'perception'),
  ('meaning_to_hanzi', 'production'),
  ('hanzi_to_pinyin', 'production'),
  ('pinyin_to_hanzi', 'production'),
  ('audio_to_hanzi', 'perception'),
  ('audio_to_meaning', 'perception'),
  ('tone_identification', 'perception'),
  ('tone_pair_identification', 'perception'),
  ('pronunciation_production', 'production'),
  ('read_aloud', 'production'),
  ('sentence_reading', 'mixed');

CREATE TABLE scheduler_configs (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,
  implementation TEXT NOT NULL,
  implementation_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL CHECK (
    json_valid(parameters_json) AND json_type(parameters_json) = 'object'
  ),
  desired_retention REAL NOT NULL CHECK (
    desired_retention > 0 AND desired_retention < 1
  ),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  optimized_at INTEGER CHECK (optimized_at IS NULL OR optimized_at >= created_at),
  optimization_metadata_json TEXT CHECK (
    optimization_metadata_json IS NULL
    OR (
      json_valid(optimization_metadata_json)
      AND json_type(optimization_metadata_json) = 'object'
    )
  )
) STRICT;

CREATE UNIQUE INDEX scheduler_configs_one_current_idx
  ON scheduler_configs(is_current)
  WHERE is_current = 1;

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('lexeme', 'lexeme_reading', 'sentence', 'grammar_topic')
  ),
  lexeme_id TEXT REFERENCES lexemes(id) ON DELETE RESTRICT,
  lexeme_reading_id TEXT REFERENCES lexeme_readings(id) ON DELETE RESTRICT,
  sentence_id TEXT REFERENCES sentences(id) ON DELETE RESTRICT,
  grammar_topic_id TEXT REFERENCES grammar_topics(id) ON DELETE RESTRICT,
  activity_type TEXT NOT NULL REFERENCES activity_types(id) ON DELETE RESTRICT,
  scheduler_eligible INTEGER NOT NULL DEFAULT 0 CHECK (scheduler_eligible IN (0, 1)),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= created_at),
  CHECK (
    (
      subject_type = 'lexeme'
      AND lexeme_id IS NOT NULL
      AND lexeme_reading_id IS NULL
      AND sentence_id IS NULL
      AND grammar_topic_id IS NULL
    )
    OR (
      subject_type = 'lexeme_reading'
      AND lexeme_id IS NULL
      AND lexeme_reading_id IS NOT NULL
      AND sentence_id IS NULL
      AND grammar_topic_id IS NULL
    )
    OR (
      subject_type = 'sentence'
      AND lexeme_id IS NULL
      AND lexeme_reading_id IS NULL
      AND sentence_id IS NOT NULL
      AND grammar_topic_id IS NULL
    )
    OR (
      subject_type = 'grammar_topic'
      AND lexeme_id IS NULL
      AND lexeme_reading_id IS NULL
      AND sentence_id IS NULL
      AND grammar_topic_id IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX cards_lexeme_activity_idx
  ON cards(lexeme_id, activity_type)
  WHERE subject_type = 'lexeme';
CREATE UNIQUE INDEX cards_reading_activity_idx
  ON cards(lexeme_reading_id, activity_type)
  WHERE subject_type = 'lexeme_reading';
CREATE UNIQUE INDEX cards_sentence_activity_idx
  ON cards(sentence_id, activity_type)
  WHERE subject_type = 'sentence';
CREATE UNIQUE INDEX cards_grammar_activity_idx
  ON cards(grammar_topic_id, activity_type)
  WHERE subject_type = 'grammar_topic';

CREATE TABLE card_state (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE RESTRICT,
  due_at INTEGER NOT NULL CHECK (due_at >= 0),
  stability REAL NOT NULL DEFAULT 0 CHECK (stability >= 0),
  difficulty REAL NOT NULL DEFAULT 0 CHECK (difficulty >= 0),
  elapsed_days INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_days >= 0),
  scheduled_days INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_days >= 0),
  learning_steps INTEGER NOT NULL DEFAULT 0 CHECK (learning_steps >= 0),
  reps INTEGER NOT NULL DEFAULT 0 CHECK (reps >= 0),
  lapses INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  state INTEGER NOT NULL DEFAULT 0 CHECK (state BETWEEN 0 AND 3),
  last_review_at INTEGER CHECK (last_review_at IS NULL OR last_review_at >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  server_seq INTEGER UNIQUE REFERENCES server_changes(seq) ON DELETE RESTRICT,
  rebuilt_at INTEGER NOT NULL CHECK (rebuilt_at >= 0)
) STRICT;

CREATE INDEX card_state_due_idx ON card_state(due_at, card_id);

CREATE TABLE study_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('study', 'reflex', 'pronunciation', 'reading', 'grammar')),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(context_json) AND json_type(context_json) = 'object'
  ),
  aggregate_json TEXT CHECK (
    aggregate_json IS NULL
    OR (json_valid(aggregate_json) AND json_type(aggregate_json) = 'object')
  ),
  server_seq INTEGER UNIQUE REFERENCES server_changes(seq) ON DELETE RESTRICT
) STRICT;

CREATE TABLE attempts (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
  device_seq INTEGER NOT NULL CHECK (device_seq > 0),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  study_session_id TEXT REFERENCES study_sessions(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('study', 'reflex', 'pronunciation', 'reading', 'grammar')),
  activity_type TEXT NOT NULL REFERENCES activity_types(id) ON DELETE RESTRICT,
  correct INTEGER CHECK (correct IS NULL OR correct IN (0, 1)),
  score REAL,
  self_rating INTEGER CHECK (self_rating IS NULL OR self_rating BETWEEN 1 AND 4),
  response_ms INTEGER CHECK (response_ms IS NULL OR response_ms >= 0),
  expected_card_state_version INTEGER CHECK (
    expected_card_state_version IS NULL OR expected_card_state_version >= 0
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  server_seq INTEGER NOT NULL UNIQUE REFERENCES server_changes(seq) ON DELETE RESTRICT,
  UNIQUE (device_id, device_seq)
) STRICT;

CREATE INDEX attempts_card_semantic_order_idx
  ON attempts(card_id, occurred_at, device_id, device_seq, event_id);
CREATE INDEX attempts_received_idx ON attempts(received_at, event_id);

CREATE TABLE fsrs_reviews (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(event_id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  scheduler_config_id TEXT NOT NULL REFERENCES scheduler_configs(id) ON DELETE RESTRICT,
  semantic_order_key TEXT NOT NULL,
  audit_previous_state_json TEXT CHECK (
    audit_previous_state_json IS NULL
    OR (
      json_valid(audit_previous_state_json)
      AND json_type(audit_previous_state_json) = 'object'
    )
  ),
  audit_new_state_json TEXT CHECK (
    audit_new_state_json IS NULL
    OR (
      json_valid(audit_new_state_json)
      AND json_type(audit_new_state_json) = 'object'
    )
  )
) STRICT;

CREATE INDEX fsrs_reviews_card_idx ON fsrs_reviews(card_id, semantic_order_key);
CREATE INDEX fsrs_reviews_config_idx ON fsrs_reviews(scheduler_config_id);

CREATE TABLE projection_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  data_through_seq INTEGER REFERENCES server_changes(seq) ON DELETE RESTRICT,
  projection_version INTEGER NOT NULL DEFAULT 0 CHECK (projection_version >= 0),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT
) STRICT;

INSERT INTO projection_state (singleton) VALUES (1);

-- D1 batch() has atomic rollback, but a conditional UPDATE does not throw when
-- its predicate misses. The ingestion batch inserts changes() here immediately
-- after its optimistic card_state UPDATE so a zero-row conflict aborts the batch.
CREATE TABLE atomic_write_guards (
  guard_id TEXT PRIMARY KEY,
  assertion INTEGER NOT NULL CHECK (assertion = 1)
) STRICT;

CREATE TRIGGER cards_scheduler_capability_insert
BEFORE INSERT ON cards
WHEN NEW.scheduler_eligible = 1
  AND NOT EXISTS (
    SELECT 1 FROM activity_types
    WHERE id = NEW.activity_type AND can_be_scheduled = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'activity type is not scheduler-capable');
END;

CREATE TRIGGER card_state_requires_scheduled_card_insert
BEFORE INSERT ON card_state
WHEN NOT EXISTS (
  SELECT 1 FROM cards WHERE id = NEW.card_id AND scheduler_eligible = 1
)
BEGIN
  SELECT RAISE(ABORT, 'card_state requires a scheduler-eligible card');
END;

CREATE TRIGGER card_state_version_increment
BEFORE UPDATE ON card_state
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'card_state version must increment by exactly one');
END;

CREATE TRIGGER attempts_card_activity_match
BEFORE INSERT ON attempts
WHEN NOT EXISTS (
  SELECT 1 FROM cards
  WHERE id = NEW.card_id AND activity_type = NEW.activity_type
)
BEGIN
  SELECT RAISE(ABORT, 'attempt activity must match its card');
END;

CREATE TRIGGER attempts_immutable_update
BEFORE UPDATE ON attempts
BEGIN
  SELECT RAISE(ABORT, 'attempts are immutable');
END;

CREATE TRIGGER attempts_immutable_delete
BEFORE DELETE ON attempts
BEGIN
  SELECT RAISE(ABORT, 'attempts are immutable');
END;

CREATE TRIGGER fsrs_reviews_contract_insert
BEFORE INSERT ON fsrs_reviews
WHEN NOT EXISTS (
  SELECT 1
  FROM attempts a
  JOIN cards c ON c.id = a.card_id
  WHERE a.event_id = NEW.attempt_id
    AND a.card_id = NEW.card_id
    AND c.scheduler_eligible = 1
)
BEGIN
  SELECT RAISE(ABORT, 'FSRS review requires its scheduled originating attempt');
END;

CREATE TRIGGER fsrs_reviews_immutable_update
BEFORE UPDATE ON fsrs_reviews
BEGIN
  SELECT RAISE(ABORT, 'FSRS reviews are immutable');
END;

CREATE TRIGGER fsrs_reviews_immutable_delete
BEFORE DELETE ON fsrs_reviews
BEGIN
  SELECT RAISE(ABORT, 'FSRS reviews are immutable');
END;

CREATE TRIGGER scheduler_configs_referenced_semantics_immutable
BEFORE UPDATE OF
  algorithm,
  implementation,
  implementation_version,
  parameters_json,
  desired_retention,
  created_at,
  optimized_at,
  optimization_metadata_json
ON scheduler_configs
WHEN EXISTS (
  SELECT 1 FROM fsrs_reviews WHERE scheduler_config_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'referenced scheduler config semantics are immutable');
END;

CREATE TRIGGER scheduler_configs_referenced_delete_prohibited
BEFORE DELETE ON scheduler_configs
WHEN EXISTS (
  SELECT 1 FROM fsrs_reviews WHERE scheduler_config_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'referenced scheduler configs cannot be deleted');
END;
