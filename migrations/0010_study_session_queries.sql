CREATE INDEX attempts_study_session_idx
  ON attempts(study_session_id, occurred_at, event_id)
  WHERE study_session_id IS NOT NULL;
