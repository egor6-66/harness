#!/usr/bin/env node
// statusline.mjs — statusLine hook: строка состояния сессии. Отвечает на вопрос «с кем я
// сейчас говорю», который иначе решается листанием переписки — а при нескольких открытых
// сессиях не решается вовсе.
//
// Роль сессии — ЕДИНСТВЕННОЕ, что здесь по-настоящему важно: identity-баннер виден только в
// начале, уезжает из видимой части экрана после первых же ходов, и дальше человек отличает
// architect от owner-<zone> по памяти. Строка состояния держит роль на экране постоянно.
//
// Контракт (Claude Code statusLine):
//   stdin  = JSON { model:{ display_name }, workspace:{ current_dir, project_dir }, ... }
//   stdout = первая строка = содержимое строки состояния (ANSI-цвета разрешены)
//   exit 0 всегда; на любой ошибке — молчаливый минимум, строка состояния не роняет сессию.
//
// Ветку читаем из `.git/HEAD` файлом, а не `git rev-parse`: хук зовётся на КАЖДЫЙ ход, и
// процесс git на каждый ход — заметная цена за строку текста.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveScope, zonePaths } from "./harness-config.mjs";

// ANSI. Держим руками (ноль зависимостей — правило обвеса): dim для фона, цвет — роли.
const DIM = "[2m";
const RESET = "[0m";
const RED = "[31m";
const CYAN = "[36m";
const GREEN = "[32m";
const YELLOW = "[33m";

const SEP = `${DIM} · ${RESET}`;

/** Текущая ветка из `.git/HEAD`; detached HEAD → короткий SHA; не прочли → null. */
function currentBranch(repoRoot) {
  try {
    const head = readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    return null;
  }
}

/**
 * Роль сессии словами и цветом. Цвет несёт смысл, а не украшает: owner видит свою зону
 * зелёной, architect — голубым (он один владеет доставкой), отсутствие роли — красным,
 * потому что это состояние, в котором работать нельзя, а выглядит оно как обычное.
 */
export function roleBadge(scope, config) {
  if (!scope) return `${RED}⚠ РОЛИ НЕТ${RESET}`;
  if (scope === "main") return `${CYAN}🏛 architect${RESET}`;
  const resolved = resolveScope(scope, config);
  if (resolved?.kind !== "zone") return `${RED}⚠ ${scope} (UNRESOLVED)${RESET}`;
  return `${GREEN}🔧 owner-${scope}${RESET}`;
}

/**
 * Границы owner'а в строке состояния — ровно те `paths[]`, которые держит governance.
 * Владелец обязан видеть свою границу, не сверяясь с конфигом: правка вне неё всё равно
 * будет отбита гейтом, но узнать об этом лучше до того, как файл написан.
 * Больше двух путей — схлопываем в счётчик, строка состояния не место для списка.
 *
 * Незнакомый scope молчит: про него уже сказал бейдж роли (UNRESOLVED), и вторая жалоба на
 * то же самое занимает место, ничего не добавляя.
 */
export function zoneBadge(scope, config) {
  if (!scope || scope === "main") return null;
  const zone = config?.zones?.[scope];
  if (!zone) return null;
  const paths = zonePaths(zone);
  if (!paths.length) return `${RED}зона без путей${RESET}`;
  if (paths.length > 2) return `${DIM}${paths[0]}/ +${paths.length - 1}${RESET}`;
  return `${DIM}${paths.map((p) => `${p}/`).join(" ")}${RESET}`;
}

export function buildLine(input, config, repoRoot) {
  const scope = process.env.HARNESS_SCOPE;
  const parts = [roleBadge(scope, config)];

  const zone = zoneBadge(scope, config);
  if (zone) parts.push(zone);

  const product = config?.product ?? basename(repoRoot);
  parts.push(`${DIM}${product}${RESET}`);

  const branch = currentBranch(repoRoot);
  // Главная ветка подсвечена: коммит в неё не пройдёт ни у кого, и увидеть это лучше
  // до того, как работа сделана и упёрлась в отказ.
  if (branch) {
    const main = branch === "main" || branch === "master";
    parts.push(main ? `${YELLOW}⎇ ${branch}${RESET}` : `${DIM}⎇ ${branch}${RESET}`);
  }

  const model = input?.model?.display_name;
  if (model) parts.push(`${DIM}${model}${RESET}`);

  return parts.join(SEP);
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    // stdin не пришёл — роль всё равно знаем из окружения, строку отдаём без модели.
  }
  const repoRoot = input?.workspace?.project_dir || input?.workspace?.current_dir || process.cwd();
  process.stdout.write(buildLine(input, loadConfig(repoRoot), repoRoot));
}

if (fileURLToPath(import.meta.url) === argv[1]) {
  try {
    main();
  } catch {
    // Строка состояния — не повод ронять ход. Молчим: пустая строка честнее вранья.
    process.stdout.write("");
  }
}
