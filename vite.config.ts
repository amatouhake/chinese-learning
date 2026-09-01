import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const SHELL_VERSION_PLACEHOLDER = "__SHELL_VERSION__";

export const SHELL_VERSION_FILES = [
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "service-worker.js",
] as const;

export function shellVersionFromFiles(readFile: (file: string) => string | Uint8Array): string {
  const hash = createHash("sha256");
  for (const file of SHELL_VERSION_FILES) {
    hash.update(file);
    hash.update(readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
}

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: "copy-staged-local-media",
      apply: "build",
      closeBundle() {
        const staged = resolve(
          process.env.CHINESE_LEARNING_STAGED_MEDIA_ROOT ?? ".generated/public",
        );
        if (existsSync(staged)) cpSync(staged, resolve("dist"), { recursive: true });

        const shellVersion = shellVersionFromFiles((file) => readFileSync(resolve("dist", file)));
        const serviceWorkerPath = resolve("dist/service-worker.js");
        const serviceWorker = readFileSync(serviceWorkerPath, "utf8");
        if (!serviceWorker.includes(SHELL_VERSION_PLACEHOLDER)) {
          throw new Error("service-worker shell version placeholder is missing");
        }
        writeFileSync(
          serviceWorkerPath,
          serviceWorker.replaceAll(SHELL_VERSION_PLACEHOLDER, shellVersion),
        );
      },
    },
  ],
  publicDir: "public",
});
