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

test("v1 import rejects unsupported options before writing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-import-option-"));
  const output = join(root, "generated/import.sql");

  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "scripts/import-v1.ts",
        "--vocabulary-root",
        root,
        "--v1-root",
        root,
        "--limt",
        "10",
        "--output",
        output,
      ],
      { cwd: projectRoot },
    );

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("unsupported import option: --limt");
    await expect(stat(output)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 import rejects an ignored untracked contributing source file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-import-ignored-"));
  const vocabularyRoot = join(root, "vocabulary");
  const v1Root = join(root, "v1");
  const vocabularyPath = join(vocabularyRoot, "wordlists/exclusive/old/1.json");
  const enrichmentPath = join(v1Root, "data/llm_generated.json");
  const output = join(root, "generated/import.sql");

  try {
    await mkdir(dirname(vocabularyPath), { recursive: true });
    await mkdir(dirname(enrichmentPath), { recursive: true });
    await writeFile(vocabularyPath, JSON.stringify([sourceLexeme("略")]));
    await writeFile(join(vocabularyRoot, ".gitignore"), "wordlists/exclusive/old/1.json\n");
    await writeFile(enrichmentPath, "[]");
    initializeGitCheckout(vocabularyRoot);
    initializeGitCheckout(v1Root);

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
    expect(new TextDecoder().decode(result.stderr)).toContain("source path is not tracked at");
    await expect(stat(output)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 import compares source bytes hidden by assume-unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-import-index-flag-"));
  const vocabularyRoot = join(root, "vocabulary");
  const v1Root = join(root, "v1");
  const relativeVocabularyPath = "wordlists/exclusive/old/1.json";
  const vocabularyPath = join(vocabularyRoot, relativeVocabularyPath);
  const enrichmentPath = join(v1Root, "data/llm_generated.json");
  const output = join(root, "generated/import.sql");

  try {
    await mkdir(dirname(vocabularyPath), { recursive: true });
    await mkdir(dirname(enrichmentPath), { recursive: true });
    await writeFile(vocabularyPath, JSON.stringify([sourceLexeme("原")]));
    await writeFile(enrichmentPath, "[]");
    initializeGitCheckout(vocabularyRoot);
    initializeGitCheckout(v1Root);

    runGit(vocabularyRoot, "update-index", "--assume-unchanged", relativeVocabularyPath);
    await writeFile(vocabularyPath, JSON.stringify([sourceLexeme("改")]));
    expect(
      gitOutput(vocabularyRoot, "status", "--porcelain=v1", "--", relativeVocabularyPath),
    ).toBe("");

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
      "worktree bytes differ from the recorded commit",
    );
    await expect(stat(output)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pronunciation import rejects tracked audio missing from the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "chinese-learning-audio-missing-"));
  const vocabularyRoot = join(root, "vocabulary");
  const audioRoot = join(root, "audio");
  const vocabularyPath = join(vocabularyRoot, "wordlists/exclusive/old/1.json");
  const audioPath = join(audioRoot, "64k/hsk/cmn-原.mp3");
  const output = join(root, "generated/pronunciation.sql");
  const mediaRoot = join(root, "generated/media");
  const report = join(root, "generated/report.json");

  try {
    await mkdir(dirname(vocabularyPath), { recursive: true });
    await mkdir(dirname(audioPath), { recursive: true });
    await writeFile(vocabularyPath, JSON.stringify([sourceLexeme("原")]));
    await writeFile(audioPath, "fixture audio bytes");
    initializeGitCheckout(vocabularyRoot);
    initializeGitCheckout(audioRoot);
    await rm(audioPath);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "scripts/import-pronunciation.ts",
        "--vocabulary-root",
        vocabularyRoot,
        "--audio-root",
        audioRoot,
        "--levels",
        "1",
        "--output",
        output,
        "--media-root",
        mediaRoot,
        "--report",
        report,
      ],
      { cwd: projectRoot },
    );

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("audio path tracked at");
    expect(new TextDecoder().decode(result.stderr)).toContain("is missing from worktree");
    await expect(stat(output)).rejects.toThrow();
    await expect(stat(report)).rejects.toThrow();
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

function gitOutput(directory: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...arguments_]);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
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
