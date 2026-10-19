#!/usr/bin/env node
// repo-boundary.mjs — PreToolUse hook: правка файла ВНЕ репозитория сессии запрещена любой роли.
//
// Граница зоны держится правилами доступа файла роли (`.claude/roles/<роль>.json`), но наружу
// репозитория у них границы нет: правилом `Edit(…)` не выразить «всё, кроме этой папки» — запрет
// сильнее разрешения, и `deny Edit(//**)` закрыл бы и свой репозиторий. А соседний репозиторий
// рядом — обычное дело (скоуп из нескольких репозиториев, линк пакетов соседа через
// `node_modules`): сессия ewc правила файлы web-core, и останавливало её только собственное
// решение. Разбор — FAQ.md.
//
// Граница — корень репозитория сессии (`CLAUDE_PROJECT_DIR`, иначе cwd). Действует только там,
// где репозиторий объявил роль-модель (`.claude/harness.yaml`): без неё у сессии нет продукта, и
// границу проводить не от чего. Наружу пускаются только служебные папки самого Claude Code
// (`CLAUDE_CONFIG_DIR` — память и планы) и временная папка системы (scratchpad).
//
// Контракт (Claude Code PreToolUse):
//   stdin  = JSON { tool_name, tool_input:{ file_path | notebook_path }, cwd, ... }
//   stdout = JSON { hookSpecificOutput:{ hookEventName, permissionDecision, permissionDecisionReason } }
//   exit 0 всегда; FAIL-OPEN на внутренних ошибках (как git-gate).

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveTarget, within } from "./ownership.mjs";

/** Тулы, которые пишут файл, и поле, где лежит путь. */
const PATH_FIELDS = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

function emit(permissionDecision, permissionDecisionReason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
      },
    }),
  );
  process.exit(0);
}

const silent = () => {
  process.stdout.write("{}");
  process.exit(0);
};

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Папки вне репозитория, куда писать законно: служебные Claude Code и временная. Настоящими
 * путями: цель сверяется по настоящему пути, а подпапки конфига бывают симлинками в другое место
 * (`projects/` с памятью — в общее хранилище), поэтому каждая разворачивается отдельно.
 */
export function allowedOutside(env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  let entries = [];
  try {
    entries = readdirSync(config).map((name) => real(join(config, name)));
  } catch {}
  return [real(config), ...entries, real(tmpdir())];
}

/**
 * Причина отказа, либо null. `target` — путь как его дал тул; `repoRoot` — корень репозитория
 * сессии. Симлинк, ведущий наружу (`node_modules/@x → ../../сосед`), разрешается до настоящего
 * пути — правка через линк такая же правка соседа.
 */
export function outsideRepo({ target, repoRoot, allowed = allowedOutside() }) {
  const root = real(repoRoot);
  const abs = resolveTarget(target, root);
  if (within(abs, root)) return null;
  if (allowed.some((dir) => within(abs, dir))) return null;
  return `файл \`${abs}\` вне репозитория сессии (\`${root}\`)`;
}

function buildMessage(reason, root) {
  return [
    `❌ Правка заблокирована harness-хуком (repo-boundary).`,
    ``,
    `Причина: ${reason}.`,
    ``,
    `Сессия запущена для репозитория \`${root}\` и правит только его. Соседний репозиторий —`,
    `другой продукт со своими зонами и своим architect, даже если он лежит рядом или прилинкован.`,
    ``,
    `Действие: STOP. Не обходи (Bash, симлинк, копия) — скажи user, что и где нужно поправить;`,
    `правку делает сессия того репозитория.`,
  ].join("\n");
}

function main() {
  let input;
  try {
    const raw = readFileSync(0, "utf8").replace(/^﻿/, "").trim();
    if (!raw) return silent();
    input = JSON.parse(raw);
  } catch {
    return silent();
  }

  const field = PATH_FIELDS[input.tool_name];
  if (!field) return silent();
  const target = String(input.tool_input?.[field] ?? "");
  if (!target) return silent();

  const repoRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  if (!existsSync(join(repoRoot, ".claude", "harness.yaml"))) return silent();

  const reason = outsideRepo({ target, repoRoot });
  if (reason) return emit("deny", buildMessage(reason, real(repoRoot)));
  silent();
}

if (fileURLToPath(import.meta.url) === argv[1]) {
  try {
    main();
  } catch {
    silent();
  }
}
