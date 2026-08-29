CREATE TRIGGER scheduler_configs_duplicate_id_insert_prohibited
BEFORE INSERT ON scheduler_configs
WHEN EXISTS (
  SELECT 1 FROM scheduler_configs WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'scheduler config IDs cannot be reinserted');
END;

CREATE TRIGGER attempts_study_session_device_match
BEFORE INSERT ON attempts
WHEN
  NEW.study_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM study_sessions
    WHERE id = NEW.study_session_id
      AND device_id = NEW.device_id
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt device must match study session device');
END;
