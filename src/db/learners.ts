import { ConflictError, InvalidInputError, ReferenceNotFoundError } from "../domain/errors";
import type { LearnerId } from "../domain/types";

export async function createLearner(
  db: D1Database,
  learnerId: LearnerId,
  createdAt: number,
): Promise<void> {
  requireIdentity(learnerId, "learner");
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new InvalidInputError("learner creation time must be a non-negative integer");
  }
  await db
    .prepare("INSERT INTO learners (id, created_at) VALUES (?, ?)")
    .bind(learnerId, createdAt)
    .run();
}

export async function registerLearnerDevice(
  db: D1Database,
  learnerId: LearnerId,
  deviceId: string,
): Promise<void> {
  requireIdentity(learnerId, "learner");
  requireIdentity(deviceId, "device");

  const learner = await db
    .prepare("SELECT id FROM learners WHERE id = ?")
    .bind(learnerId)
    .first<{ id: string }>();
  if (!learner) throw new ReferenceNotFoundError("learner", learnerId);

  await db
    .prepare("INSERT OR IGNORE INTO learner_devices (id, learner_id) VALUES (?, ?)")
    .bind(deviceId, learnerId)
    .run();
  const device = await db
    .prepare("SELECT learner_id FROM learner_devices WHERE id = ?")
    .bind(deviceId)
    .first<{ learner_id: string }>();
  if (device?.learner_id !== learnerId) {
    throw new ConflictError(`device ${deviceId} belongs to another learner`);
  }
}

function requireIdentity(value: string, label: string): void {
  if (!value.trim() || value.length > 200) {
    throw new InvalidInputError(`${label} ID must be a non-empty string of at most 200 characters`);
  }
}
