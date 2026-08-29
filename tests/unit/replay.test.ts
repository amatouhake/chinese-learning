import { describe, expect, test } from "bun:test";

import {
  FSRS_ALGORITHM,
  FSRS_IMPLEMENTATION,
  FSRS_IMPLEMENTATION_VERSION,
  createFsrsParameters,
  replayFsrsHistory,
} from "../../src/domain/fsrs";
import {
  compareCanonicalReviews,
  normalizeUtcInstant,
  semanticOrderKey,
} from "../../src/domain/ordering";
import type { CanonicalFsrsReview, SchedulerConfig } from "../../src/domain/types";

const configX = schedulerConfig("config-x", 0.8, 30);
const configY = schedulerConfig("config-y", 0.97, 36_500);

describe("canonical FSRS replay", () => {
  test("orders a late A/C/B history by semantic occurrence, not arrival", () => {
    const [a, b, c] = reviews();
    expect([a, b, c].sort(compareCanonicalReviews).map((review) => review.eventId)).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  test("uses SQLite BINARY UTF-8 order for Unicode identity tie-breaks", () => {
    const base: CanonicalFsrsReview = {
      eventId: "shared-event",
      cardId: "card-1",
      deviceId: "\u{10000}",
      deviceSeq: 1,
      occurredAt: Date.parse("2026-08-29T10:00:00Z"),
      rating: 1,
      schedulerConfigId: configX.id,
    };
    const astral = base;
    const privateUseBmp = { ...base, deviceId: "\uE000", rating: 4 as const };

    expect(astral.deviceId < privateUseBmp.deviceId).toBe(true);
    expect(
      [astral, privateUseBmp].sort(compareCanonicalReviews).map((review) => review.deviceId),
    ).toEqual([privateUseBmp.deviceId, astral.deviceId]);
  });

  test("semantic order keys preserve tuple order for delimiter control characters", () => {
    const base: CanonicalFsrsReview = {
      eventId: "event-a",
      cardId: "card-1",
      deviceId: "a",
      deviceSeq: 1,
      occurredAt: Date.parse("2026-08-29T10:00:00Z"),
      rating: 1,
      schedulerConfigId: configX.id,
    };
    const prefixedDevice = { ...base, eventId: "event-b", deviceId: "a\u001f!" };
    const reviews = [prefixedDevice, base];
    const tupleOrder = [...reviews].sort(compareCanonicalReviews).map((review) => review.eventId);
    const keyOrder = [...reviews]
      .sort((left, right) => {
        const leftKey = semanticOrderKey(left);
        const rightKey = semanticOrderKey(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((review) => review.eventId);

    expect(tupleOrder).toEqual([base.eventId, prefixedDevice.eventId]);
    expect(keyOrder).toEqual(tupleOrder);
    expect(new Set(reviews.map(semanticOrderKey)).size).toBe(reviews.length);
  });

  test("rebuilds the same state from the same immutable inputs in any arrival order", () => {
    const [a, b, c] = reviews();
    const configs = new Map([
      [configX.id, configX],
      [configY.id, configY],
    ]);

    const arrivalOrder = replayFsrsHistory([a, b, c], configs);
    const canonicalOrder = replayFsrsHistory([a, c, b], configs);
    const reversed = replayFsrsHistory([b, c, a], configs);

    expect(arrivalOrder).toEqual(canonicalOrder);
    expect(reversed).toEqual(canonicalOrder);
  });

  test("uses each review's referenced scheduler config", () => {
    const [a, b, c] = reviews();
    const configs = new Map([
      [configX.id, configX],
      [configY.id, configY],
    ]);
    const referenced = replayFsrsHistory([a, c, b], configs);
    const silentlySubstituted = replayFsrsHistory(
      [a, c, b].map((review) => ({ ...review, schedulerConfigId: configY.id })),
      configs,
    );

    expect(referenced).not.toEqual(silentlySubstituted);
  });

  test("requires timestamp offsets so local wall time cannot become canonical", () => {
    expect(normalizeUtcInstant("2026-08-29T10:00:00+09:00")).toBe(
      Date.parse("2026-08-29T01:00:00Z"),
    );
    expect(() => normalizeUtcInstant("2026-08-29T10:00:00")).toThrow("explicit UTC offset");
  });

  test("rejects calendar rollover while accepting a valid leap day", () => {
    expect(() => normalizeUtcInstant("2026-02-30T00:00:00Z")).toThrow("invalid calendar");
    expect(() => normalizeUtcInstant("2025-02-29T00:00:00+09:00")).toThrow("invalid calendar");
    expect(normalizeUtcInstant("2024-02-29T00:00:00.123Z")).toBe(
      Date.parse("2024-02-29T00:00:00.123Z"),
    );
  });
});

function schedulerConfig(id: string, retention: number, maximumInterval: number): SchedulerConfig {
  const defaults = createFsrsParameters(retention);
  const weightScale = maximumInterval > 1_000 ? 1.8 : 1;
  return {
    id,
    algorithm: FSRS_ALGORITHM,
    implementation: FSRS_IMPLEMENTATION,
    implementationVersion: FSRS_IMPLEMENTATION_VERSION,
    parameters: createFsrsParameters(retention, {
      maximum_interval: maximumInterval,
      w: defaults.w.map((weight, index) => (index < 4 ? weight * weightScale : weight)),
    }),
    desiredRetention: retention,
  };
}

function reviews(): CanonicalFsrsReview[] {
  const shared = {
    cardId: "card-1",
    deviceId: "phone",
    schedulerConfigId: configX.id,
  };
  return [
    {
      ...shared,
      eventId: "A",
      deviceSeq: 1,
      occurredAt: Date.parse("2026-08-29T10:00:00Z"),
      rating: 3,
    },
    {
      ...shared,
      eventId: "B",
      deviceId: "desktop",
      deviceSeq: 1,
      occurredAt: Date.parse("2026-08-29T12:00:00Z"),
      rating: 2,
      schedulerConfigId: configY.id,
    },
    {
      ...shared,
      eventId: "C",
      deviceSeq: 2,
      occurredAt: Date.parse("2026-08-29T11:00:00Z"),
      rating: 4,
    },
  ];
}
