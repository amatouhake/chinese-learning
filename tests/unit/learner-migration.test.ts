import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { semanticOrderKey } from "../../src/domain/ordering";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

describe("learner identity migration", () => {
  test("backfills the legacy singleton history into the fixed owner without loss", async () => {
    const db = new Database(":memory:");
    try {
      for (const path of [...new Bun.Glob("migrations/*.sql").scanSync()].sort()) {
        if (path.endsWith("0015_learner_identity_foundation.sql")) continue;
        db.exec(await Bun.file(path).text());
      }
      seedLegacyHistory(db);
      const before = legacySnapshot(db);

      db.exec("BEGIN");
      try {
        db.exec(await Bun.file("migrations/0015_learner_identity_foundation.sql").text());
        const migrationViolations = db.query("PRAGMA foreign_key_check").all();
        if (migrationViolations.length > 0) {
          throw new Error(
            `migration foreign-key violations: ${JSON.stringify(migrationViolations)}`,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.query("SELECT id, created_at FROM learners").all()).toEqual([
        { id: FIXED_OWNER_LEARNER_ID, created_at: 0 },
      ]);
      expect(
        db.query("SELECT learner_id, timezone, updated_at FROM learner_settings").all(),
      ).toEqual([{ learner_id: FIXED_OWNER_LEARNER_ID, timezone: "Asia/Tokyo", updated_at: 1234 }]);
      expect(db.query("SELECT * FROM content_state").get()).toEqual({
        singleton: 1,
        current_content_revision: 1,
        updated_at: 1234,
      });
      expect(db.query("SELECT id, learner_id FROM learner_devices").all()).toEqual([
        { id: "legacy-device", learner_id: FIXED_OWNER_LEARNER_ID },
      ]);
      expect(
        db
          .query(
            `SELECT event_id, learner_id, device_id, device_seq, server_seq
             FROM attempts`,
          )
          .get(),
      ).toEqual({
        event_id: "legacy-attempt",
        learner_id: FIXED_OWNER_LEARNER_ID,
        device_id: "legacy-device",
        device_seq: 1,
        server_seq: 3,
      });
      expect(
        db
          .query(
            `SELECT learner_id, card_id, due_at, reps, version, server_seq
             FROM card_state`,
          )
          .get(),
      ).toEqual({
        learner_id: FIXED_OWNER_LEARNER_ID,
        card_id: "legacy-card",
        due_at: 2000,
        reps: 1,
        version: 1,
        server_seq: 4,
      });
      expect(
        db
          .query(
            `SELECT learner_id, id, device_id, mode, server_seq
             FROM study_sessions`,
          )
          .get(),
      ).toEqual({
        learner_id: FIXED_OWNER_LEARNER_ID,
        id: "legacy-session",
        device_id: "legacy-device",
        mode: "study",
        server_seq: 2,
      });
      expect(
        db
          .query(
            `SELECT learner_id, entity_type, entity_id
             FROM server_changes ORDER BY seq`,
          )
          .all(),
      ).toEqual([
        { learner_id: null, entity_type: "content", entity_id: "content-revision:1" },
        {
          learner_id: FIXED_OWNER_LEARNER_ID,
          entity_type: "study_session",
          entity_id: "legacy-session",
        },
        {
          learner_id: FIXED_OWNER_LEARNER_ID,
          entity_type: "attempt",
          entity_id: "legacy-attempt",
        },
        {
          learner_id: FIXED_OWNER_LEARNER_ID,
          entity_type: "card_state",
          entity_id: "legacy-card",
        },
      ]);
      expect(legacySnapshot(db)).toEqual(before);
      expect(
        db
          .query(
            `SELECT learner_id, dirty, last_attempt_at
             FROM projection_state`,
          )
          .get(),
      ).toEqual({ learner_id: FIXED_OWNER_LEARNER_ID, dirty: 1, last_attempt_at: 1500 });
    } finally {
      db.close();
    }
  });
});

function seedLegacyHistory(db: Database): void {
  const orderKey = semanticOrderKey({
    eventId: "legacy-attempt",
    cardId: "legacy-card",
    deviceId: "legacy-device",
    deviceSeq: 1,
    occurredAt: 1500,
    rating: 3,
    schedulerConfigId: "fsrs-6:ts-fsrs@5.4.1:default:0.90:v1",
  });
  db.exec(`
    INSERT INTO content_revisions
      (source, source_version, description, created_at)
    VALUES ('legacy-source', 'legacy-v1', 'legacy content', 1000);

    UPDATE learner_settings
    SET current_content_revision = 1, updated_at = 1234
    WHERE singleton = 1;

    INSERT INTO lexemes
      (id, simplified, meanings_json, source, content_revision, created_at, updated_at)
    VALUES ('legacy-lexeme', '旧', '[{"language":"ja","text":"古い"}]',
      'legacy-source', 1, 1000, 1000);

    INSERT INTO cards
      (id, subject_type, lexeme_id, activity_type, scheduler_eligible,
       content_revision, created_at)
    VALUES ('legacy-card', 'lexeme', 'legacy-lexeme', 'hanzi_to_meaning', 1, 1, 1000);

    INSERT INTO server_changes
      (change_id, entity_type, entity_id, operation, content_revision, changed_at)
    VALUES ('legacy-content-change', 'content', 'content-revision:1', 'upsert', 1, 1000);

    INSERT INTO server_changes
      (change_id, entity_type, entity_id, operation, changed_at)
    VALUES ('legacy-session-change', 'study_session', 'legacy-session', 'upsert', 1400);

    INSERT INTO study_sessions
      (id, device_id, mode, started_at, context_json, server_seq)
    VALUES ('legacy-session', 'legacy-device', 'study', 1400, '{"maxCards":1}', 2);

    INSERT INTO server_changes
      (change_id, entity_type, entity_id, operation, changed_at)
    VALUES ('legacy-attempt-change', 'attempt', 'legacy-attempt', 'upsert', 1600);

    INSERT INTO attempts
      (event_id, device_id, device_seq, occurred_at, received_at, card_id,
       study_session_id, mode, activity_type, correct, expected_card_state_version,
       metadata_json, server_seq)
    VALUES ('legacy-attempt', 'legacy-device', 1, 1500, 1600, 'legacy-card',
      'legacy-session', 'study', 'hanzi_to_meaning', 1, 0, '{}', 3);

    INSERT INTO fsrs_reviews
      (attempt_id, card_id, rating, scheduler_config_id, semantic_order_key,
       audit_previous_state_json, audit_new_state_json)
    VALUES (
      'legacy-attempt', 'legacy-card', 3,
      'fsrs-6:ts-fsrs@5.4.1:default:0.90:v1',
      ${sqlText(orderKey)},
      '{"version":0}',
      '{"version":1}'
    );

    INSERT INTO server_changes
      (change_id, entity_type, entity_id, operation, changed_at)
    VALUES ('legacy-card-state-change', 'card_state', 'legacy-card', 'upsert', 1600);

    INSERT INTO card_state
      (card_id, due_at, stability, difficulty, elapsed_days, scheduled_days,
       learning_steps, reps, lapses, state, last_review_at, version, server_seq, rebuilt_at)
    VALUES ('legacy-card', 2000, 1.5, 5, 0, 1, 0, 1, 0, 2, 1500, 1, 4, 1600);

    UPDATE projection_state
    SET dirty = 1, data_through_seq = 4, projection_version = 7, last_attempt_at = 1500
    WHERE singleton = 1;
  `);
}

function legacySnapshot(db: Database): Record<string, unknown> {
  return {
    attempts: db.query("SELECT COUNT(*) AS count FROM attempts").get(),
    reviews: db.query("SELECT COUNT(*) AS count FROM fsrs_reviews").get(),
    review: db
      .query(
        `SELECT attempt_id, card_id, rating, scheduler_config_id, semantic_order_key,
          audit_previous_state_json, audit_new_state_json
         FROM fsrs_reviews`,
      )
      .get(),
    content: db.query("SELECT source, source_version, description FROM content_revisions").get(),
  };
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
