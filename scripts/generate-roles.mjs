#!/usr/bin/env node
// Строит файлы настроек по роли из `.claude/harness.yaml` репозитория. Границу зоны и git-права
// держат штатные permissions, а не наш код — разбор в README.md плагина, раздел «Почему правила,
// а не хуки».
//
//   node <плагин>/scripts/generate-roles.mjs [путь до репозитория]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { loadConfig, zonePaths } = await import(join(here, "..", "hooks", "harness-config.mjs"));

const repo = resolve(process.argv[2] ?? process.cwd());
const config = loadConfig(repo);
const zones = Object.keys(config.zones ?? {});

if (zones.length === 0) {
  console.error(`зон в ${join(repo, ".claude", "harness.yaml")} нет — генерировать нечего`);
  process.exit(1);
}

// Git здесь НЕ описывается, и это решение, а не пробел: правила из этого файла приезжают только
// вместе с `--settings`, а забыть флаг легко — тогда git остался бы без границы вовсе. Git держит
// гейт, он включён всегда и роль читает из `HARNESS_SCOPE` ниже. Одна механика на предмет:
// файлы — правила, git — гейт.
const editRule = (path) => `Edit(${path}/**)`;

function ownerSettings(zone) {
  const mine = zonePaths(config.zones[zone]);
  const others = zones
    .filter((other) => other !== zone)
    .flatMap((other) => zonePaths(config.zones[other]));

  return {
    $comment:
      `Роль owner-${zone}. Правка — только в своих путях: остальные зоны в deny. Git здесь не ` +
      `описан — его держит гейт, включённый всегда. Файл ПОРОЖДЁН: ` +
      `node <плагин>/scripts/generate-roles.mjs`,
    env: { HARNESS_SCOPE: zone },
    permissions: {
      allow: mine.map(editRule),
      deny: others.map(editRule),
    },
  };
}

function architectSettings() {
  return {
    $comment:
      "Роль architect. Границ по файлам нет — своё всё, что не отдано зоне; запись в общий " +
      "`.git` ставит вопрос человеку, и это делает гейт. Файл ПОРОЖДЁН: " +
      "node <плагин>/scripts/generate-roles.mjs",
    env: { HARNESS_SCOPE: "main" },
  };
}

function layerSettings() {
  return {
    $comment:
      "Роль layer — один артефакт по узкому промпту; git не трогает вовсе, это держит гейт. " +
      "Файл ПОРОЖДЁН: node <плагин>/scripts/generate-roles.mjs",
    env: { HARNESS_SCOPE: "layer" },
  };
}

const out = join(repo, ".claude", "roles");
mkdirSync(out, { recursive: true });

const written = [];
for (const zone of zones) {
  writeFileSync(join(out, `${zone}.json`), `${JSON.stringify(ownerSettings(zone), null, 2)}\n`);
  written.push(`${zone}.json`);
}
writeFileSync(join(out, "main.json"), `${JSON.stringify(architectSettings(), null, 2)}\n`);
writeFileSync(join(out, "layer.json"), `${JSON.stringify(layerSettings(), null, 2)}\n`);
written.push("main.json", "layer.json");

console.log(`роль-файлов записано: ${written.length} → ${out}`);
console.log(`запуск сессии: claude --settings .claude/roles/<роль>.json`);
