import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const browserRoot = join(projectRoot, ".generated/browser-test");
const supportedOptions = new Set(["--vocabulary-root", "--v1-root", "--audio-root"]);

const { vocabularyRoot, v1Root, audioRoot } = parseArguments(Bun.argv.slice(2));
const vocabularyImport = join(browserRoot, "v1-import.sql");
const pronunciationImport = join(browserRoot, "pronunciation-import.sql");
const mediaRoot = join(browserRoot, "public/media");
const report = join(browserRoot, "pronunciation-report.json");
const persistenceRoot = join(browserRoot, "d1");
const wrangler = join(projectRoot, "node_modules/.bin/wrangler");

await rm(browserRoot, { recursive: true, force: true });
await mkdir(browserRoot, { recursive: true });

await run([
  process.execPath,
  "run",
  "scripts/import-v1.ts",
  "--vocabulary-root",
  vocabularyRoot,
  "--v1-root",
  v1Root,
  "--output",
  vocabularyImport,
]);
await run([
  process.execPath,
  "run",
  "scripts/import-pronunciation.ts",
  "--vocabulary-root",
  vocabularyRoot,
  "--audio-root",
  audioRoot,
  "--output",
  pronunciationImport,
  "--media-root",
  mediaRoot,
  "--report",
  report,
]);
await run(
  [
    wrangler,
    "d1",
    "migrations",
    "apply",
    "chinese-learning",
    "--local",
    "--persist-to",
    persistenceRoot,
  ],
  true,
);
for (const importPath of [vocabularyImport, pronunciationImport]) {
  await run(
    [
      wrangler,
      "d1",
      "execute",
      "chinese-learning",
      "--local",
      "--persist-to",
      persistenceRoot,
      "--file",
      importPath,
    ],
    true,
  );
}

console.log(`Prepared isolated browser data under ${browserRoot}`);
try {
  await run([process.execPath, "run", "test:browser:run"]);
} catch (error) {
  await reportWranglerFailure();
  throw error;
}

function parseArguments(arguments_: string[]): {
  vocabularyRoot: string;
  v1Root: string;
  audioRoot: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key || !supportedOptions.has(key) || value === undefined) throw usageError();
    if (values.has(key)) throw usageError(`duplicate option: ${key}`);
    values.set(key, value);
  }
  return {
    vocabularyRoot:
      values.get("--vocabulary-root") ?? join(tmpdir(), "chinese-learning-complete-hsk-vocabulary"),
    v1Root: values.get("--v1-root") ?? join(tmpdir(), "chinese-learning-v1-source"),
    audioRoot: values.get("--audio-root") ?? join(tmpdir(), "chinese-learning-audio-cmn"),
  };
}

async function run(command: string[], quietOutput = false): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(browserRoot, "wrangler.log"),
      XDG_CONFIG_HOME: join(browserRoot, "config"),
    },
    stdout: quietOutput ? "ignore" : "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`command failed (${command[0]}) with exit code ${exitCode}`);
}

async function reportWranglerFailure(): Promise<void> {
  try {
    const log = await readFile(join(browserRoot, "wrangler.log"), "utf8");
    const importantLines = log
      .split("\n")
      .filter((line) =>
        /^(--- .* (error|debug)|✘ \[ERROR\]|Error$|\s{4}at .*ProxyController|\s{4}at .*#handleLoopback|.*Network connection lost)/u.test(
          line,
        ),
      )
      .slice(-80);
    if (importantLines.length > 0) {
      console.error("Wrangler browser-server diagnostic:\n" + importantLines.join("\n"));
    }
  } catch {
    // The Playwright failure remains the primary error when Wrangler did not create a log.
  }
}

function usageError(reason?: string): Error {
  return new Error(
    (reason ? `${reason}\n` : "") +
      "Usage: bun run test:browser -- [--vocabulary-root <pinned checkout>] " +
      "[--v1-root <pinned checkout>] [--audio-root <pinned checkout>]",
  );
}
