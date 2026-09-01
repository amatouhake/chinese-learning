import { expect, test } from "bun:test";

import { SHELL_VERSION_FILES, shellVersionFromFiles } from "../../vite.config";

test("shell version inputs include every installable app mark asset", async () => {
  expect(SHELL_VERSION_FILES).toContain("icon-maskable-512.png");
  expect(await Bun.file("public/service-worker.js").text()).toContain('"/icon-maskable-512.png"');
});

test("changing only the maskable app mark changes the shell version", () => {
  const files = new Map<string, string>(SHELL_VERSION_FILES.map((file) => [file, "stable"]));
  const original = shellVersionFromFiles((file) => files.get(file) ?? "");
  files.set("icon-maskable-512.png", "updated");
  const updated = shellVersionFromFiles((file) => files.get(file) ?? "");

  expect(updated).not.toBe(original);
});
