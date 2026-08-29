DROP TRIGGER scheduler_configs_referenced_semantics_immutable;
DROP TRIGGER scheduler_configs_referenced_delete_prohibited;

CREATE TRIGGER scheduler_configs_semantics_immutable
BEFORE UPDATE OF
  id,
  algorithm,
  implementation,
  implementation_version,
  parameters_json,
  desired_retention,
  created_at,
  optimized_at,
  optimization_metadata_json
ON scheduler_configs
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.algorithm IS NOT OLD.algorithm
  OR NEW.implementation IS NOT OLD.implementation
  OR NEW.implementation_version IS NOT OLD.implementation_version
  OR NEW.parameters_json IS NOT OLD.parameters_json
  OR NEW.desired_retention IS NOT OLD.desired_retention
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.optimized_at IS NOT OLD.optimized_at
  OR NEW.optimization_metadata_json IS NOT OLD.optimization_metadata_json
BEGIN
  SELECT RAISE(ABORT, 'scheduler config identity and semantics are immutable');
END;

CREATE TRIGGER scheduler_configs_delete_prohibited
BEFORE DELETE ON scheduler_configs
BEGIN
  SELECT RAISE(ABORT, 'scheduler configs cannot be deleted');
END;
