-- Main's v1 importer stored source spellings such as `nü` and `lü` verbatim.
-- Pronunciation foundation uses `v` as the stable internal spelling for ü, so
-- upgrade those persisted arrays before pronunciation cards validate them.
UPDATE lexeme_readings
SET normalized_syllables_json = replace(
  replace(normalized_syllables_json, 'u:', 'v'),
  'ü',
  'v'
)
WHERE normalized_syllables_json LIKE '%u:%'
   OR normalized_syllables_json LIKE '%ü%';

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type = 'audio'),
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  mime_type TEXT NOT NULL CHECK (mime_type = 'audio/mpeg'),
  license TEXT NOT NULL,
  attribution TEXT NOT NULL,
  delivery_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (source, source_version, source_path)
) STRICT;

CREATE TABLE lexeme_reading_media (
  lexeme_reading_id TEXT NOT NULL REFERENCES lexeme_readings(id) ON DELETE RESTRICT,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role = 'word_pronunciation'),
  mapping_basis TEXT NOT NULL CHECK (
    mapping_basis = 'exact_hanzi_filename_single_active_reading'
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  PRIMARY KEY (lexeme_reading_id, role),
  UNIQUE (media_asset_id, role)
) WITHOUT ROWID, STRICT;

CREATE INDEX lexeme_reading_media_asset_idx
  ON lexeme_reading_media(media_asset_id, lexeme_reading_id);

CREATE TRIGGER media_assets_immutable_update
BEFORE UPDATE ON media_assets
BEGIN
  SELECT RAISE(ABORT, 'media assets are immutable');
END;

CREATE TRIGGER media_assets_immutable_delete
BEFORE DELETE ON media_assets
BEGIN
  SELECT RAISE(ABORT, 'media assets are immutable');
END;

CREATE TRIGGER lexeme_reading_media_requires_active_reading
BEFORE INSERT ON lexeme_reading_media
WHEN NOT EXISTS (
  SELECT 1 FROM lexeme_readings
  WHERE id = NEW.lexeme_reading_id AND retired_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'reading media requires an active reading');
END;

CREATE TRIGGER attempts_study_session_mode_match
BEFORE INSERT ON attempts
WHEN NEW.study_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = NEW.study_session_id AND mode = NEW.mode
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt mode must match its study session');
END;
