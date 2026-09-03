import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  assertNoBundledCredentials,
  checkProductionArtifacts,
} from "../../scripts/check-production-artifacts";

test("production artifact guard checks staged and copied media and frontend credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-artifacts-"));
  const staged = join(root, "staged-media");
  const distMedia = join(root, "dist", "media");
  try {
    await mkdir(join(staged, "audio"), { recursive: true });
    await mkdir(join(distMedia, "audio"), { recursive: true });
    for (const name of ["one.mp3", "two.mp3"]) {
      await Bun.write(join(staged, "audio", name), "mp3");
      await Bun.write(join(distMedia, "audio", name), "mp3");
    }
    await Bun.write(join(root, "dist", "app.js"), "console.log('safe');");

    await expect(
      checkProductionArtifacts({
        stagedMediaRoot: staged,
        distRoot: distMedia,
        expectedMediaFiles: 2,
      }),
    ).resolves.toMatchObject({ stagedMediaFiles: 2, deployedMediaFiles: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production artifact guard rejects missing media and credential-like bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-artifacts-"));
  const staged = join(root, "staged-media");
  const distMedia = join(root, "dist", "media");
  try {
    await mkdir(staged, { recursive: true });
    await mkdir(distMedia, { recursive: true });
    await Bun.write(join(staged, "one.mp3"), "mp3");
    await expect(
      checkProductionArtifacts({
        stagedMediaRoot: staged,
        distRoot: distMedia,
        expectedMediaFiles: 2,
      }),
    ).rejects.toThrow("must contain 2 MP3 files");

    await Bun.write(join(root, "dist", "app.js"), "const token = 'ATTEMPT_WRITE_TOKEN';");
    await expect(assertNoBundledCredentials(join(root, "dist"))).rejects.toThrow(
      "credential-like value",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
