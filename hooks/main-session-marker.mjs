#!/usr/bin/env node
// main-session-marker.mjs — SessionStart hook: ДОПИСЫВАЕТ session_id в marker ТОЛЬКО для scope 'main'.
//
// user запускает каждую сессию с `HARNESS_SCOPE=<scope>` в окружении — это единственный вход
// роли (лаунчер-скрипта нет: `devbox-session.sh` снят, девбокс поднимает спека Dev Containers).
// Destructive git ops по канону — только scope 'main' (architect). Любой другой scope
// (owner-*) НЕ должен трогать marker. Пишется ТОЛЬКО если HARNESS_SCOPE === 'main'.
//
// Marker — МНОЖЕСТВО id (по строке на сессию), не одна строка: резюм сессии выдаёт
// НОВЫЙ session_id (SessionStart на resume дописывает его), а параллельные main-сессии
// не затирают друг друга (перезапись single-slot ловила architect'а на stale-маркере —
// дыра, найдена 2026-07-09). Кап — последние 20 id (стейлы уезжают сами).
//
// Subagents (Agent tool) SessionStart НЕ триггерят → сюда не попадают → всегда gated.
//
// Contract (SessionStart): stdin JSON { session_id, cwd, ... }; stdout {}; exit 0 (fail-open).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

function silent() {
  process.stdout.write("{}");
  process.exit(0);
}

function main() {
  let input;
  try {
    // strip BOM: Windows-пайпы (PowerShell) могут префиксовать stdin.
    input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    silent();
    return;
  }

  const scope = process.env.HARNESS_SCOPE;
  if (scope !== "main") {
    silent();
    return;
  }

  const sessionId = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!sessionId) {
    silent();
    return;
  }

  const marker = join(cwd, ".claude", ".main-session-id");
  try {
    mkdirSync(dirname(marker), { recursive: true });
    let ids = [];
    try {
      ids = readFileSync(marker, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      /* нет файла — начинаем с пустого */
    }
    ids = ids.filter((id) => id !== String(sessionId));
    ids.push(String(sessionId)); // свежий — в конец; кап срезает старейшие
    writeFileSync(marker, `${ids.slice(-20).join("\n")}\n`, "utf8");
  } catch {
    /* fail-open */
  }

  silent();
}

// Исполняем main() ТОЛЬКО как скрипт (main читает stdin(0) и вызывает process.exit).
if (fileURLToPath(import.meta.url) === argv[1]) {
  try {
    main();
  } catch {
    silent();
  }
}
