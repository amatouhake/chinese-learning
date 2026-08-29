CREATE UNIQUE INDEX content_revisions_source_version_idx
  ON content_revisions(source, source_version)
  WHERE source_version IS NOT NULL;
