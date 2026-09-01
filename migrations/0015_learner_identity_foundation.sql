PRAGMA defer_foreign_keys = ON;

-- Learners are canonical domain identities. Authentication providers may resolve
-- to these IDs later, but are deliberately not part of this foundation.
CREATE TABLE learners (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

INSERT INTO learners (id, created_at)
VALUES ('learner:owner:v1', 0);

-- Device IDs remain globally unique and belong to exactly one learner. The
-- browser still supplies its durable device ID; the trusted request learner is
-- the parent used when a device is first registered.
CREATE TABLE learner_devices (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE RESTRICT,
  UNIQUE (learner_id, id)
) STRICT;

INSERT INTO learner_devices (id, learner_id)
SELECT device_id, 'learner:owner:v1'
FROM (
  SELECT device_id FROM study_sessions
  UNION
  SELECT device_id FROM attempts
);

-- Content import state is global infrastructure, not a learner preference.
CREATE TABLE content_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_content_revision INTEGER REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO content_state (singleton, current_content_revision, updated_at)
SELECT 1, current_content_revision, updated_at
FROM learner_settings
WHERE singleton = 1;

CREATE TABLE learner_settings_new (
  learner_id TEXT PRIMARY KEY REFERENCES learners(id) ON DELETE RESTRICT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO learner_settings_new (learner_id, timezone, updated_at)
SELECT 'learner:owner:v1', timezone, updated_at
FROM learner_settings
WHERE singleton = 1;

-- Content changes have no learner. Every learner-state change has exactly one.
ALTER TABLE server_changes
ADD COLUMN learner_id TEXT REFERENCES learners(id) ON DELETE RESTRICT;

UPDATE server_changes
SET learner_id = 'learner:owner:v1'
WHERE entity_type <> 'content';

CREATE UNIQUE INDEX server_changes_learner_seq_idx
  ON server_changes(learner_id, seq);
CREATE INDEX server_changes_learner_pull_idx
  ON server_changes(learner_id, seq, entity_type);

CREATE TRIGGER server_changes_ownership_insert
BEFORE INSERT ON server_changes
WHEN
  (NEW.entity_type = 'content' AND NEW.learner_id IS NOT NULL)
  OR (NEW.entity_type <> 'content' AND NEW.learner_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'server change ownership does not match its entity type');
END;

CREATE TRIGGER server_changes_ownership_update
BEFORE UPDATE OF learner_id, entity_type ON server_changes
WHEN
  (NEW.entity_type = 'content' AND NEW.learner_id IS NOT NULL)
  OR (NEW.entity_type <> 'content' AND NEW.learner_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'server change ownership does not match its entity type');
END;

CREATE TABLE study_sessions_new (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE RESTRICT,
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
  server_seq INTEGER UNIQUE,
  UNIQUE (learner_id, id),
  FOREIGN KEY (learner_id, device_id)
    REFERENCES learner_devices(learner_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (learner_id, server_seq)
    REFERENCES server_changes(learner_id, seq)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO study_sessions_new (
  id, learner_id, device_id, mode, started_at, ended_at,
  context_json, aggregate_json, server_seq
)
SELECT
  id, 'learner:owner:v1', device_id, mode, started_at, ended_at,
  context_json, aggregate_json, server_seq
FROM study_sessions;

CREATE TABLE attempts_new (
  event_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
  device_seq INTEGER NOT NULL CHECK (device_seq > 0),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  study_session_id TEXT,
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
  server_seq INTEGER NOT NULL UNIQUE,
  UNIQUE (device_id, device_seq),
  FOREIGN KEY (learner_id, device_id)
    REFERENCES learner_devices(learner_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (learner_id, study_session_id)
    REFERENCES study_sessions_new(learner_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (learner_id, server_seq)
    REFERENCES server_changes(learner_id, seq)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO attempts_new (
  event_id, learner_id, device_id, device_seq, occurred_at, received_at,
  card_id, study_session_id, mode, activity_type, correct, score, self_rating,
  response_ms, expected_card_state_version, metadata_json, server_seq
)
SELECT
  event_id, 'learner:owner:v1', device_id, device_seq, occurred_at, received_at,
  card_id, study_session_id, mode, activity_type, correct, score, self_rating,
  response_ms, expected_card_state_version, metadata_json, server_seq
FROM attempts;

CREATE TABLE fsrs_reviews_new (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts_new(event_id) ON DELETE RESTRICT,
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

INSERT INTO fsrs_reviews_new (
  attempt_id, card_id, rating, scheduler_config_id, semantic_order_key,
  audit_previous_state_json, audit_new_state_json
)
SELECT
  attempt_id, card_id, rating, scheduler_config_id, semantic_order_key,
  audit_previous_state_json, audit_new_state_json
FROM fsrs_reviews;

CREATE TABLE card_state_new (
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
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
  server_seq INTEGER UNIQUE,
  rebuilt_at INTEGER NOT NULL CHECK (rebuilt_at >= 0),
  PRIMARY KEY (learner_id, card_id),
  FOREIGN KEY (learner_id, server_seq)
    REFERENCES server_changes(learner_id, seq)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

INSERT INTO card_state_new (
  learner_id, card_id, due_at, stability, difficulty, elapsed_days,
  scheduled_days, learning_steps, reps, lapses, state, last_review_at,
  version, server_seq, rebuilt_at
)
SELECT
  'learner:owner:v1', card_id, due_at, stability, difficulty, elapsed_days,
  scheduled_days, learning_steps, reps, lapses, state, last_review_at,
  version, server_seq, rebuilt_at
FROM card_state;

CREATE TABLE grammar_topic_state_new (
  learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE RESTRICT,
  grammar_topic_id TEXT NOT NULL REFERENCES grammar_topics(id) ON DELETE RESTRICT,
  status TEXT CHECK (status IS NULL OR status IN ('introduced', 'learning', 'comfortable')),
  introduced_at INTEGER CHECK (introduced_at IS NULL OR introduced_at >= 0),
  last_studied_at INTEGER CHECK (last_studied_at IS NULL OR last_studied_at >= 0),
  self_confidence REAL CHECK (
    self_confidence IS NULL OR (self_confidence >= 0 AND self_confidence <= 1)
  ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  server_seq INTEGER UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  PRIMARY KEY (learner_id, grammar_topic_id),
  FOREIGN KEY (learner_id, server_seq)
    REFERENCES server_changes(learner_id, seq)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

INSERT INTO grammar_topic_state_new (
  learner_id, grammar_topic_id, status, introduced_at, last_studied_at,
  self_confidence, version, server_seq, metadata_json
)
SELECT
  'learner:owner:v1', grammar_topic_id, status, introduced_at, last_studied_at,
  self_confidence, version, server_seq, metadata_json
FROM grammar_topic_state;

CREATE TABLE projection_state_new (
  learner_id TEXT PRIMARY KEY REFERENCES learners(id) ON DELETE RESTRICT,
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  data_through_seq INTEGER REFERENCES server_changes(seq) ON DELETE RESTRICT,
  projection_version INTEGER NOT NULL DEFAULT 0 CHECK (projection_version >= 0),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT
) STRICT;

INSERT INTO projection_state_new (
  learner_id, dirty, data_through_seq, projection_version,
  last_attempt_at, last_success_at, last_error
)
SELECT
  'learner:owner:v1', dirty, data_through_seq, projection_version,
  last_attempt_at, last_success_at, last_error
FROM projection_state
WHERE singleton = 1;

-- These triggers reference attempts from fsrs_reviews and must be recreated
-- around the SQLite table reconstruction.
DROP TRIGGER fsrs_reviews_contract_insert;
DROP TRIGGER fsrs_reviews_semantic_order_key_contract;
DROP TRIGGER scheduler_configs_semantics_immutable;
DROP TRIGGER scheduler_configs_delete_prohibited;

DROP TABLE fsrs_reviews;
DROP TABLE attempts;
DROP TABLE study_sessions;
DROP TABLE card_state;
DROP TABLE grammar_topic_state;
DROP TABLE projection_state;
DROP TABLE learner_settings;

ALTER TABLE attempts_new RENAME TO attempts;
ALTER TABLE fsrs_reviews_new RENAME TO fsrs_reviews;
ALTER TABLE study_sessions_new RENAME TO study_sessions;
ALTER TABLE card_state_new RENAME TO card_state;
ALTER TABLE grammar_topic_state_new RENAME TO grammar_topic_state;
ALTER TABLE projection_state_new RENAME TO projection_state;
ALTER TABLE learner_settings_new RENAME TO learner_settings;

CREATE INDEX attempts_learner_card_semantic_order_idx
  ON attempts(learner_id, card_id, occurred_at, device_id, device_seq, event_id);
CREATE INDEX attempts_learner_received_idx
  ON attempts(learner_id, received_at, event_id);
CREATE INDEX attempts_learner_study_session_idx
  ON attempts(learner_id, study_session_id, occurred_at, event_id)
  WHERE study_session_id IS NOT NULL;
CREATE INDEX attempts_learner_reflex_session_idx
  ON attempts(learner_id, study_session_id, event_id)
  WHERE mode = 'reflex';
CREATE INDEX attempts_learner_progress_occurrence_idx
  ON attempts(learner_id, occurred_at, mode, activity_type, card_id);
CREATE INDEX fsrs_reviews_card_idx ON fsrs_reviews(card_id, semantic_order_key);
CREATE INDEX fsrs_reviews_config_idx ON fsrs_reviews(scheduler_config_id);
CREATE INDEX card_state_learner_due_idx
  ON card_state(learner_id, due_at, card_id);
CREATE INDEX grammar_topic_state_learner_status_idx
  ON grammar_topic_state(learner_id, status, grammar_topic_id);

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

CREATE TRIGGER fsrs_reviews_semantic_order_key_contract
BEFORE INSERT ON fsrs_reviews
WHEN
  EXISTS (
    SELECT 1 FROM attempts WHERE event_id = NEW.attempt_id
  )
  AND NEW.semantic_order_key <> (
    SELECT
      printf('%016d', occurred_at)
      || char(31)
      || hex(device_id)
      || char(31)
      || printf('%020d', device_seq)
      || char(31)
      || hex(event_id)
    FROM attempts
    WHERE event_id = NEW.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'FSRS review semantic order key must match its attempt');
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

CREATE TRIGGER scheduler_configs_semantics_immutable
BEFORE UPDATE OF
  id,
  algorithm,
  implementation,
  implementation_version,
  parameters_json,
  desired_retention,
  created_at,
  optimized_at,
  optimization_metadata_json
ON scheduler_configs
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.algorithm IS NOT OLD.algorithm
  OR NEW.implementation IS NOT OLD.implementation
  OR NEW.implementation_version IS NOT OLD.implementation_version
  OR NEW.parameters_json IS NOT OLD.parameters_json
  OR NEW.desired_retention IS NOT OLD.desired_retention
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.optimized_at IS NOT OLD.optimized_at
  OR NEW.optimization_metadata_json IS NOT OLD.optimization_metadata_json
BEGIN
  SELECT RAISE(ABORT, 'scheduler config identity and semantics are immutable');
END;

CREATE TRIGGER scheduler_configs_delete_prohibited
BEFORE DELETE ON scheduler_configs
BEGIN
  SELECT RAISE(ABORT, 'scheduler configs cannot be deleted');
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

CREATE TRIGGER attempts_study_session_device_match
BEFORE INSERT ON attempts
WHEN
  NEW.study_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = NEW.study_session_id
      AND learner_id = NEW.learner_id
      AND device_id = NEW.device_id
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt device must match study session device');
END;

CREATE TRIGGER attempts_study_session_mode_match
BEFORE INSERT ON attempts
WHEN NEW.study_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = NEW.study_session_id
      AND learner_id = NEW.learner_id
      AND mode = NEW.mode
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt mode must match its study session');
END;

CREATE TRIGGER study_sessions_ownership_immutable
BEFORE UPDATE OF learner_id, device_id ON study_sessions
WHEN
  (NEW.learner_id IS NOT OLD.learner_id OR NEW.device_id IS NOT OLD.device_id)
BEGIN
  SELECT RAISE(ABORT, 'study session ownership is immutable');
END;

CREATE TRIGGER learner_devices_ownership_immutable
BEFORE UPDATE OF id, learner_id ON learner_devices
WHEN NEW.id IS NOT OLD.id OR NEW.learner_id IS NOT OLD.learner_id
BEGIN
  SELECT RAISE(ABORT, 'device ownership is immutable');
END;

CREATE TRIGGER attempts_reflex_sequence_insert
BEFORE INSERT ON attempts
WHEN
  NEW.mode = 'reflex'
  AND json_extract(NEW.metadata_json, '$.interaction') = 'reflex-multiple-choice'
BEGIN
  SELECT CASE WHEN
    NEW.study_session_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM study_sessions
      WHERE id = NEW.study_session_id
        AND learner_id = NEW.learner_id
        AND mode = 'reflex'
    )
  THEN RAISE(ABORT, 'canonical Reflex attempt requires a Reflex session') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = NEW.study_session_id
      AND learner_id = NEW.learner_id
      AND ended_at IS NOT NULL
  ) THEN RAISE(ABORT, 'canonical Reflex session has ended') END;

  SELECT CASE WHEN COALESCE(json_type(NEW.metadata_json, '$.round'), '') <> 'integer'
    THEN RAISE(ABORT, 'canonical Reflex attempt requires an integer round')
  END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM attempts
    WHERE learner_id = NEW.learner_id
      AND study_session_id = NEW.study_session_id
      AND mode = 'reflex'
      AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'
  ) >= (
    SELECT json_extract(context_json, '$.maxItems')
    FROM study_sessions
    WHERE id = NEW.study_session_id AND learner_id = NEW.learner_id
  ) THEN RAISE(ABORT, 'canonical Reflex session reached its prepared bound') END;

  SELECT CASE WHEN json_extract(NEW.metadata_json, '$.round') <> 1 + (
    SELECT COUNT(*)
    FROM attempts
    WHERE learner_id = NEW.learner_id
      AND study_session_id = NEW.study_session_id
      AND mode = 'reflex'
      AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'
  ) THEN RAISE(ABORT, 'canonical Reflex attempt is not the next session round') END;
END;

-- New learners receive independent default settings/projection rows and fresh
-- FSRS state for every existing scheduled content card.
CREATE TRIGGER learners_initialize_settings
AFTER INSERT ON learners
BEGIN
  INSERT INTO learner_settings (learner_id, timezone, updated_at)
  VALUES (NEW.id, 'Asia/Tokyo', NEW.created_at);
END;

CREATE TRIGGER learners_initialize_projection
AFTER INSERT ON learners
BEGIN
  INSERT INTO projection_state (learner_id)
  VALUES (NEW.id);
END;

CREATE TRIGGER learners_initialize_card_state
AFTER INSERT ON learners
BEGIN
  INSERT INTO card_state (learner_id, card_id, due_at, rebuilt_at)
  SELECT NEW.id, id, NEW.created_at, NEW.created_at
  FROM cards
  WHERE scheduler_eligible = 1;
END;

-- A later content import creates one fresh state row per learner while keeping
-- the card definition itself global.
CREATE TRIGGER cards_initialize_learner_state
AFTER INSERT ON cards
WHEN NEW.scheduler_eligible = 1
BEGIN
  INSERT INTO card_state (learner_id, card_id, due_at, rebuilt_at)
  SELECT id, NEW.id, NEW.created_at, NEW.created_at
  FROM learners;
END;
