CREATE INDEX attempts_progress_occurrence_idx
  ON attempts(occurred_at, mode, activity_type, card_id);
