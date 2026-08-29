import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

test("v1 import rejects a modified contributing source file before writing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-import-"));
  const vocabularyRoot = join(root, "vocabulary");
  const v1Root = join(root, "v1");
  const vocabularyPath = join(vocabularyRoot, "wordlists/exclusive/old/1.json");
  const enrichmentPath = join(v1Root, "data/llm_generated.json");
  const output = join(root, "generated/import.sql");

  try {
    await mkdir(dirname(vocabularyPath), { recursive: true });
    await mkdir(dirname(enrichmentPath), { recursive: true });
    await writeFile(vocabularyPath, JSON.stringify([sourceLexeme("原")]));
    await writeFile(enrichmentPath, "[]");
    initializeGitCheckout(vocabularyRoot);
    initializeGitCheckout(v1Root);

    const committed = await readFile(vocabularyPath, "utf8");
    await writeFile(vocabularyPath, committed.replace("原", "改"));

    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "scripts/import-v1.ts",
        "--vocabulary-root",
        vocabularyRoot,
        "--v1-root",
        v1Root,
        "--levels",
        "1",
        "--output",
        output,
      ],
      { cwd: projectRoot },
    );

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "refusing to attribute modified imported source paths",
    );
    await expect(stat(output)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function initializeGitCheckout(directory: string): void {
  runGit(directory, "init", "--quiet");
  runGit(directory, "config", "user.name", "Import Test");
  runGit(directory, "config", "user.email", "import-test@example.invalid");
  runGit(directory, "add", ".");
  runGit(directory, "commit", "--quiet", "-m", "fixture");
}

function runGit(directory: string, ...arguments_: string[]): void {
  const result = Bun.spawnSync(["git", "-C", directory, ...arguments_]);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function sourceLexeme(simplified: string): Record<string, unknown> {
  return {
    simplified,
    forms: [
      {
        traditional: simplified,
        transcriptions: { pinyin: "yuán", numeric: "yuan2" },
        meanings: ["original"],
      },
    ],
  };
}
