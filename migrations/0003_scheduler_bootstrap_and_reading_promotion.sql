CREATE TRIGGER lexeme_readings_promote_preferred
BEFORE UPDATE OF is_preferred ON lexeme_readings
WHEN NEW.is_preferred = 1 AND OLD.is_preferred = 0
BEGIN
  UPDATE lexeme_readings
  SET is_preferred = 0
  WHERE lexeme_id = NEW.lexeme_id
    AND id <> NEW.id
    AND is_preferred = 1;
END;

INSERT INTO scheduler_configs (
  id,
  algorithm,
  implementation,
  implementation_version,
  parameters_json,
  desired_retention,
  is_current,
  created_at,
  optimization_metadata_json
)
SELECT
  'fsrs-6:ts-fsrs@5.4.1:default:0.90:v1',
  'fsrs-6',
  'ts-fsrs',
  '5.4.1',
  '{"request_retention":0.9,"maximum_interval":36500,"w":[0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542],"enable_fuzz":false,"enable_short_term":true,"learning_steps":["1m","10m"],"relearning_steps":["10m"]}',
  0.9,
  1,
  0,
  '{"kind":"bootstrap-default","parameters":"ts-fsrs 5.4.1 generator defaults"}'
WHERE NOT EXISTS (
  SELECT 1 FROM scheduler_configs WHERE is_current = 1
)
ON CONFLICT(id) DO UPDATE SET is_current = 1;
