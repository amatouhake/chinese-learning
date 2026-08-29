CREATE TRIGGER study_sessions_linked_device_immutable
BEFORE UPDATE OF device_id ON study_sessions
WHEN
  NEW.device_id IS NOT OLD.device_id
  AND EXISTS (
    SELECT 1 FROM attempts
    WHERE study_session_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'linked study session device is immutable');
END;
