DROP TRIGGER fsrs_reviews_immutable_update;

-- Re-encode only the derived key representation from each immutable attempt's
-- canonical tuple; no review input or ordering meaning changes.
UPDATE fsrs_reviews
SET semantic_order_key = (
  SELECT
    printf('%016d', attempts.occurred_at)
    || char(31)
    || hex(attempts.device_id)
    || char(31)
    || printf('%020d', attempts.device_seq)
    || char(31)
    || hex(attempts.event_id)
  FROM attempts
  WHERE attempts.event_id = fsrs_reviews.attempt_id
);

CREATE TRIGGER fsrs_reviews_immutable_update
BEFORE UPDATE ON fsrs_reviews
BEGIN
  SELECT RAISE(ABORT, 'FSRS reviews are immutable');
END;

CREATE TRIGGER fsrs_reviews_semantic_order_key_contract
BEFORE INSERT ON fsrs_reviews
WHEN
  EXISTS (
    SELECT 1 FROM attempts WHERE event_id = NEW.attempt_id
  )
  AND NEW.semantic_order_key <> (
    SELECT
      printf('%016d', occurred_at)
      || char(31)
      || hex(device_id)
      || char(31)
      || printf('%020d', device_seq)
      || char(31)
      || hex(event_id)
    FROM attempts
    WHERE event_id = NEW.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'FSRS review semantic order key must match its attempt');
END;
