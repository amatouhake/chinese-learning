CREATE TABLE grammar_practice_versions (
  id TEXT PRIMARY KEY,
  grammar_topic_id TEXT NOT NULL REFERENCES grammar_topics(id) ON DELETE RESTRICT,
  sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE RESTRICT,
  practice_json TEXT NOT NULL CHECK (
    json_valid(practice_json) AND json_type(practice_json) = 'object'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (grammar_topic_id, content_revision)
) STRICT;

CREATE INDEX grammar_practice_versions_topic_idx
  ON grammar_practice_versions(grammar_topic_id, content_revision);

CREATE TRIGGER grammar_practice_versions_immutable_update
BEFORE UPDATE ON grammar_practice_versions
BEGIN
  SELECT RAISE(ABORT, 'grammar practice versions are immutable');
END;

CREATE TRIGGER grammar_practice_versions_immutable_delete
BEFORE DELETE ON grammar_practice_versions
BEGIN
  SELECT RAISE(ABORT, 'grammar practice versions cannot be deleted');
END;
