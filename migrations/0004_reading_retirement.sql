ALTER TABLE lexeme_readings
ADD COLUMN retired_at INTEGER CHECK (
  retired_at IS NULL OR retired_at >= created_at
);

CREATE INDEX lexeme_readings_active_lexeme_idx
  ON lexeme_readings(lexeme_id, is_preferred)
  WHERE retired_at IS NULL;

CREATE TRIGGER lexeme_readings_retired_not_preferred_insert
BEFORE INSERT ON lexeme_readings
WHEN NEW.retired_at IS NOT NULL AND NEW.is_preferred = 1
BEGIN
  SELECT RAISE(ABORT, 'retired reading cannot be preferred');
END;

CREATE TRIGGER lexeme_readings_retired_not_preferred_update
BEFORE UPDATE OF retired_at, is_preferred ON lexeme_readings
WHEN NEW.retired_at IS NOT NULL AND NEW.is_preferred = 1
BEGIN
  SELECT RAISE(ABORT, 'retired reading cannot be preferred');
END;
