import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const EXPECTED_STATIC_MEDIA_FILES = 480;

export interface ProductionArtifactCheckOptions {
  stagedMediaRoot?: string;
  distRoot?: string;
  expectedMediaFiles?: number;
}

export async function checkProductionArtifacts(
  options: ProductionArtifactCheckOptions = {},
): Promise<{ stagedMediaFiles: number; deployedMediaFiles: number }> {
  const stagedMediaRoot = options.stagedMediaRoot ?? ".generated/public/media";
  const distRoot = options.distRoot ?? "dist/media";
  const expectedMediaFiles = options.expectedMediaFiles ?? EXPECTED_STATIC_MEDIA_FILES;
  const stagedMedia = await findFiles(stagedMediaRoot, (path) => path.endsWith(".mp3"));
  if (stagedMedia.length !== expectedMediaFiles) {
    throw new Error(
      `staged pronunciation media must contain ${expectedMediaFiles} MP3 files; found ${stagedMedia.length}`,
    );
  }

  const deployedMedia = await findFiles(distRoot, (path) => path.endsWith(".mp3"));
  if (deployedMedia.length !== expectedMediaFiles) {
    throw new Error(
      `dist pronunciation media must contain ${expectedMediaFiles} MP3 files; found ${deployedMedia.length}`,
    );
  }

  await assertNoBundledCredentials(dirname(distRoot));
  return { stagedMediaFiles: stagedMedia.length, deployedMediaFiles: deployedMedia.length };
}

export async function assertNoBundledCredentials(root: string): Promise<void> {
  const files = await findFiles(root, () => true);
  const forbidden = [
    /ATTEMPT_WRITE_TOKEN/u,
    /integration-test-write-token/u,
    /replace-with-a-long-random-secret/u,
    /CLOUDFLARE_(?:API_TOKEN|API_KEY)/u,
    /\bBearer\s+[A-Za-z0-9._~-]{24,}/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  ];
  for (const file of files) {
    const text = await Bun.file(file).text();
    if (forbidden.some((pattern) => pattern.test(text))) {
      throw new Error(`frontend artifact contains a credential-like value: ${file}`);
    }
  }
}

async function findFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findFiles(path, predicate)));
    else if (entry.isFile() && predicate(path)) files.push(path);
  }
  return files;
}

if (import.meta.main) {
  try {
    const summary = await checkProductionArtifacts();
    console.log(JSON.stringify({ ok: true, ...summary }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
