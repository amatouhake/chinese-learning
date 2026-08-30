import { svelte } from "@sveltejs/vite-plugin-svelte";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: "copy-staged-local-media",
      apply: "build",
      closeBundle() {
        const staged = resolve(".generated/public");
        if (existsSync(staged)) cpSync(staged, resolve("dist"), { recursive: true });
      },
    },
  ],
  publicDir: "public",
});
