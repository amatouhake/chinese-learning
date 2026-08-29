import { expect, test } from "bun:test";

import { parseAttemptInput } from "../../src/domain/validation";

const validAttempt = {
  eventId: "validation-event",
  deviceId: "validation-device",
  deviceSeq: 1,
  occurredAt: "2026-08-29T10:00:00Z",
  cardId: "validation-card",
  mode: "study",
  activityType: "hanzi_to_meaning",
};

test("attempt integer fields reject values outside the JavaScript safe range", () => {
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  expect(() => parseAttemptInput({ ...validAttempt, responseMs: unsafeInteger })).toThrow(
    "responseMs",
  );
  expect(() =>
    parseAttemptInput({ ...validAttempt, expectedCardStateVersion: unsafeInteger }),
  ).toThrow("expectedCardStateVersion");
  expect(() => parseAttemptInput({ ...validAttempt, deviceSeq: unsafeInteger })).toThrow(
    "deviceSeq",
  );
});
