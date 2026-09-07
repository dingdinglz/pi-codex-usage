import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("pi's real extension loader accepts the package without starting network work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-usage-loader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("Network forbidden in loader test"); });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [resolve(".")] }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(fetches, 0);
});
