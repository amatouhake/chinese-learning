-- Canonical Reflex attempts are ordinary immutable attempts, but their round
-- and session bound must be decided by the same SQLite transaction that
-- inserts the attempt. Service-level preflight checks alone can race.
CREATE INDEX attempts_reflex_session_idx
  ON attempts(study_session_id, event_id)
  WHERE mode = 'reflex';

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
      WHERE id = NEW.study_session_id AND mode = 'reflex'
    )
  THEN RAISE(ABORT, 'canonical Reflex attempt requires a Reflex session') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = NEW.study_session_id AND ended_at IS NOT NULL
  ) THEN RAISE(ABORT, 'canonical Reflex session has ended') END;

  SELECT CASE WHEN COALESCE(json_type(NEW.metadata_json, '$.round'), '') <> 'integer'
    THEN RAISE(ABORT, 'canonical Reflex attempt requires an integer round')
  END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM attempts
    WHERE study_session_id = NEW.study_session_id
      AND mode = 'reflex'
      AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'
  ) >= (
    SELECT json_extract(context_json, '$.maxItems')
    FROM study_sessions
    WHERE id = NEW.study_session_id
  ) THEN RAISE(ABORT, 'canonical Reflex session reached its prepared bound') END;

  SELECT CASE WHEN json_extract(NEW.metadata_json, '$.round') <> 1 + (
    SELECT COUNT(*)
    FROM attempts
    WHERE study_session_id = NEW.study_session_id
      AND mode = 'reflex'
      AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'
  ) THEN RAISE(ABORT, 'canonical Reflex attempt is not the next session round') END;
END;
