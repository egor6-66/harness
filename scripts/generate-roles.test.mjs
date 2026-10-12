// node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "generate-roles.mjs");

function generate(zonesYaml) {
  const repo = mkdtempSync(join(tmpdir(), "harness-roles-"));
  mkdirSync(join(repo, ".claude"));
  writeFileSync(
    join(repo, ".claude", "harness.yaml"),
    `apiVersion: harness/v1\nkind: harness\nproduct: t\nzones:\n${zonesYaml}`,
  );
  execFileSync(process.execPath, [script, repo], { stdio: "pipe" });
  return (zone) => JSON.parse(readFileSync(join(repo, ".claude", "roles", `${zone}.json`), "utf8"));
}

test("зона со вложенной папкой, названной именем другой зоны", () => {
  const role = generate("  solid:\n    paths: [solid]\n  settings:\n    paths: [settings]\n");
  const { allow, deny } = role("settings").permissions;
  // разрешение — от корня: покрывает settings/src/solid/index.ts
  assert.deepEqual(allow, ["Edit(settings/**)"]);
  // запрет — привязанная форма: не «solid на любой глубине», а корневая solid/
  assert.deepEqual(deny, ["Edit(solid/**/*)"]);
  assert.ok(!deny.includes("Edit(solid/**)"));
});

test("у всех ролей запреты в привязанной форме, разрешения прежние", () => {
  const role = generate("  a:\n    paths: [a, a2]\n  b:\n    paths: [b]\n");
  assert.deepEqual(role("a").permissions, {
    allow: ["Edit(a/**)", "Edit(a2/**)"],
    deny: ["Edit(b/**/*)"],
  });
  assert.deepEqual(role("b").permissions.deny, ["Edit(a/**/*)", "Edit(a2/**/*)"]);
});
