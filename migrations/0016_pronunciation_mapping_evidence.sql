-- Mapping rationale belongs to the audio-to-reading relationship. The audio
-- bytes in media_assets remain immutable and keep their existing provenance.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE lexeme_reading_media RENAME TO lexeme_reading_media_legacy;

CREATE TABLE lexeme_reading_media (
  lexeme_reading_id TEXT NOT NULL REFERENCES lexeme_readings(id) ON DELETE RESTRICT,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role = 'word_pronunciation'),
  mapping_basis TEXT NOT NULL CHECK (
    mapping_basis IN (
      'exact_hanzi_filename_single_active_reading',
      'exact_source_pronunciation_active_reading'
    )
  ),
  source_text TEXT CHECK (source_text IS NULL OR length(trim(source_text)) > 0),
  source_pronunciation TEXT CHECK (
    source_pronunciation IS NULL OR length(trim(source_pronunciation)) > 0
  ),
  normalized_source_pinyin TEXT CHECK (
    normalized_source_pinyin IS NULL
    OR (json_valid(normalized_source_pinyin) AND json_type(normalized_source_pinyin) = 'array')
  ),
  metadata_source_id TEXT CHECK (
    metadata_source_id IS NULL OR length(trim(metadata_source_id)) > 0
  ),
  metadata_source_digest TEXT CHECK (
    metadata_source_digest IS NULL
    OR (
      length(metadata_source_digest) = 64
      AND metadata_source_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  metadata_source_record_path TEXT CHECK (
    metadata_source_record_path IS NULL OR length(trim(metadata_source_record_path)) > 0
  ),
  content_revision INTEGER NOT NULL REFERENCES content_revisions(revision) ON DELETE RESTRICT,
  PRIMARY KEY (lexeme_reading_id, role),
  UNIQUE (media_asset_id, role),
  CHECK (
    (
      mapping_basis = 'exact_hanzi_filename_single_active_reading'
      AND source_text IS NULL
      AND source_pronunciation IS NULL
      AND normalized_source_pinyin IS NULL
      AND metadata_source_id IS NULL
      AND metadata_source_digest IS NULL
      AND metadata_source_record_path IS NULL
    )
    OR (
      mapping_basis = 'exact_source_pronunciation_active_reading'
      AND source_text IS NOT NULL
      AND source_pronunciation IS NOT NULL
      AND normalized_source_pinyin IS NOT NULL
      AND metadata_source_id IS NOT NULL
      AND metadata_source_digest IS NOT NULL
      AND metadata_source_record_path IS NOT NULL
    )
  )
) WITHOUT ROWID, STRICT;

INSERT INTO lexeme_reading_media (
  lexeme_reading_id, media_asset_id, role, mapping_basis, content_revision
)
SELECT
  lexeme_reading_id, media_asset_id, role, mapping_basis, content_revision
FROM lexeme_reading_media_legacy;

DROP TABLE lexeme_reading_media_legacy;

CREATE INDEX lexeme_reading_media_asset_idx
  ON lexeme_reading_media(media_asset_id, lexeme_reading_id);

CREATE TRIGGER lexeme_reading_media_requires_active_reading
BEFORE INSERT ON lexeme_reading_media
WHEN NOT EXISTS (
  SELECT 1 FROM lexeme_readings
  WHERE id = NEW.lexeme_reading_id AND retired_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'reading media requires an active reading');
END;
