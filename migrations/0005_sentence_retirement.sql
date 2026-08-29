ALTER TABLE sentences
ADD COLUMN retired_at INTEGER CHECK (
  retired_at IS NULL OR retired_at >= created_at
);

CREATE INDEX sentences_active_source_idx
  ON sentences(source, id)
  WHERE retired_at IS NULL;
