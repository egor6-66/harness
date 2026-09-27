#!/usr/bin/env node

// harness-doctor.mjs — самопроверка установки харнесса. НЕ хук: запускается руками из корня репо.
//   node .claude/hooks/harness-doctor.mjs                 # общий отчёт
//   HARNESS_SCOPE=<scope> node .claude/hooks/harness-doctor.mjs   # + кто ты при этом scope
//
// Печатает реальность (продукт · зоны+существование папок · твоя роль · регистрация хуков ·
// marker), чтобы не приходилось «понимать по описанию»: запустил — увидел. Zero-deps
// (node:* + harness-config).
//
// ЗАЧЕМ здесь проверка регистрации хуков. `.claude/settings.json` — общий файл клиента
// (permissions, env, свои хуки), и обвес кладёт его классом `placed-once`: один раз и дальше
// не трогает. Цена класса — новые хуки следующих версий обвеса приезжают в `.claude/hooks/`,
// а РЕГИСТРАЦИЯ их не приезжает, потому что живёт в том самом файле. Форма baser выразить это
// не может (режимов материализации в записи нет, `merge` отменён), поэтому деградацию делаем
// ГРОМКОЙ: доктор сверяет эталонный блок регистрации с настоящим settings.json и печатает
// строку, которую нужно дописать. Это не обход формы — механизм не подменяется, называется то,
// что механизм назвать не может.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import {
  gitAccess,
  knownScopes,
  loadConfig,
  needsOnboarding,
  overlappingZones,
  PLACEHOLDER_PRODUCT,
  parseYaml,
  rejectedZoneNames,
  resolveScope,
  roleOf,
  validateConfig,
  zonePaths,
  zoneReality,
} from "./harness-config.mjs";

/** Имя эталонного блока регистрации внутри contentRoot обвеса. */
export const REGISTRATION_BLOCK = "settings.hooks.json";
const CONSUMER_SETTINGS = join(".claude", "settings.json");

// --- регистрация хуков: эталон, факт, расхождение ----------------------------

/** Плоский список объявленных регистраций: {event, matcher, command}. */
export function declaredRegistrations(block) {
  const out = [];
  for (const [event, groups] of Object.entries(block?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = group?.matcher ?? null;
      for (const hook of group?.hooks ?? []) {
        if (typeof hook?.command === "string") out.push({ event, matcher, command: hook.command });
      }
    }
  }
  return out;
}

/** Зарегистрирована ли ровно эта тройка (событие · matcher · команда) в settings.json. */
export function isRegistered(settings, { event, matcher, command }) {
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (g) => (g?.matcher ?? null) === matcher && (g?.hooks ?? []).some((h) => h?.command === command),
  );
}

/** Что объявлено эталоном, но не зарегистрировано у потребителя. */
export function missingRegistrations(settings, block) {
  return declaredRegistrations(block).filter((r) => !isRegistered(settings, r));
}

/** Готовая строка, которую человеку нужно дописать в `.claude/settings.json`. */
export function registrationFix(missing) {
  const byEvent = new Map();
  for (const r of missing) {
    if (!byEvent.has(r.event)) byEvent.set(r.event, []);
    byEvent.get(r.event).push(r);
  }
  const lines = [];
  for (const [event, regs] of byEvent) {
    const groups = [];
    const byMatcher = new Map();
    for (const r of regs) {
      if (!byMatcher.has(r.matcher)) byMatcher.set(r.matcher, []);
      byMatcher.get(r.matcher).push(r.command);
    }
    for (const [matcher, commands] of byMatcher) {
      const group = matcher === null ? {} : { matcher };
      group.hooks = commands.map((command) => ({ type: "command", command }));
      groups.push(group);
    }
    lines.push(`"${event}": ${JSON.stringify(groups)}`);
  }
  return lines;
}

/**
 * Хуки теперь везёт ПЛАГИН, а не `settings.json` репозитория: эталона регистрации здесь больше
 * нет и быть не может — плагин объявляет их сам, своим `hooks/hooks.json`. Репозиторию остаётся
 * ДВЕ вещи, и обе проверяются ниже: включён ли плагин и разложены ли файлы ролей.
 */
export function registrationReport(cwd, _moduleUrl, { ok, bad, warn }) {
  const lines = [];
  const settingsPath = join(cwd, CONSUMER_SETTINGS);
  let settings = null;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    settings = null;
  }
  if (settings === null) {
    lines.push(bad(`${CONSUMER_SETTINGS} не найден/не читается — роль-модель не подключена`));
    lines.push("    → без него нет ни ролей, ни опознания сессии, ни проверки коммита.");
    return lines;
  }

  const enabled = Object.entries(settings.enabledPlugins ?? {}).filter(
    ([key, on]) => on === true && key.startsWith("harness@"),
  );
  if (!enabled.length) {
    lines.push(bad(`плагин роль-модели не включён в ${CONSUMER_SETTINGS}`));
    lines.push('    Допиши: "enabledPlugins": { "harness@<маркетплейс>": true }');
  } else {
    const [key] = enabled[0];
    const market = key.split("@")[1];
    lines.push(ok(`плагин роль-модели включён: ${key}`));
    if (!settings.extraKnownMarketplaces?.[market]) {
      lines.push(warn(`маркетплейс \`${market}\` не объявлен — у того, кто клонировал, плагин не найдётся`));
      lines.push(`    Допиши в "extraKnownMarketplaces" запись \`${market}\` с её source.`);
    }
  }

  lines.push(...rolesReport(cwd, { ok, bad, warn }));
  lines.push(...statusLineNote({ ok, warn }));
  return lines;
}

/**
 * Строка состояния — ЛИЧНАЯ настройка: плагин её задать не может, а репозиторий задавать не
 * должен (путь до установленного плагина у каждого свой). Поэтому здесь не проверка, а напоминание
 * тому, у кого роль на экране не видна.
 */
export function statusLineNote({ ok, warn }) {
  // Каталог настроек переносим: он не всегда `~/.claude` — переменная главнее домашней папки.
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "~", ".claude");
  const userSettings = join(configDir, "settings.json");
  let declared = false;
  try {
    declared = Boolean(JSON.parse(readFileSync(userSettings, "utf8"))?.statusLine?.command);
  } catch {
    declared = false;
  }
  if (declared) return [ok("строка состояния объявлена в личных настройках")];
  return [
    warn("строка состояния не объявлена — роль сессии не видна на экране постоянно"),
    "    Ничего не ломает, но при нескольких открытых сессиях роль отличают по памяти.",
    `    Включается в СВОИХ настройках (${userSettings}): "statusLine" с командой`,
    "    `node <путь до установленного плагина>/hooks/statusline.mjs`.",
  ];
}

/** Отчёт по файлам ролей: есть ли на каждую зону, и совпадает ли объявленная в нём роль. */
export function rolesReport(cwd, { ok, bad, warn }) {
  const config = loadConfig(cwd);
  const zones = Object.keys(config.zones ?? {});
  const expected = [...zones, "main", "layer"];
  const dir = join(cwd, ".claude", "roles");
  const missing = [];
  const mismatched = [];

  for (const name of expected) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    try {
      const declared = JSON.parse(readFileSync(file, "utf8"))?.env?.HARNESS_SCOPE;
      if (declared !== name) mismatched.push(`${name}.json объявляет роль \`${declared ?? "—"}\``);
    } catch {
      mismatched.push(`${name}.json не читается`);
    }
  }

  const lines = [];
  if (missing.length) {
    lines.push(bad(`файлов ролей нет: ${missing.length} из ${expected.length} (${missing.join(", ")})`));
    lines.push("    Собери их из конфига: node <плагин>/scripts/generate-roles.mjs");
  } else {
    lines.push(ok(`файлы ролей на месте: ${expected.length} (зон ${zones.length} + main + layer)`));
  }
  for (const line of mismatched) lines.push(warn(line));
  return lines;
}

// --- машинный pre-commit: есть он или его нет (BRAIN2-64) --------------------
//
// ГРАНИЦА, названная вслух, чтобы через месяц её не «дочинили»: git-хуки потребителя — ЕГО
// территория. Обвес их НЕ везёт и молча не ставит. Рынок здесь единодушен (сверено 2026-08-01):
// husky ставится явным `npx husky init` + `prepare` в манифесте ПОТРЕБИТЕЛЯ, lefthook —
// `lefthook install`, python-фреймворк pre-commit — `pre-commit install`. Ни один не приезжает
// хуком за компанию с зависимостью: инструмент, который ты завёл, и хук, который тебе положили
// в `.git/`, — разные вещи, и второе никто не делает.
//
// Наше дело — сказать ПРАВДУ о том, есть машина или нет: рамка требует зелёный pre-commit, и
// агент, который считает, что его проверят, ведёт себя иначе, чем тот, кто знает, что не
// проверят (случай owner-сессии baser, ).

/** Каталог `.git`: папка либо файл `gitdir: …` (worktree/submodule). null — репозитория нет. */
export function gitDirOf(cwd) {
  const dot = join(cwd, ".git");
  if (!existsSync(dot)) return null;
  try {
    const text = readFileSync(dot, "utf8"); // папку прочитать не выйдет → catch ниже
    const ref = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    return ref ? resolve(cwd, ref) : null;
  } catch {
    return dot; // это папка
  }
}

/** `core.hooksPath` из `.git/config` (INI: секция `[core]`), либо null. */
export function hooksPathOf(gitDir) {
  let text;
  try {
    text = readFileSync(join(gitDir, "config"), "utf8");
  } catch {
    return null;
  }
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    if (section !== "core") continue;
    const kv = /^\s*hooksPath\s*=\s*(.+?)\s*$/i.exec(line);
    if (kv) return kv[1];
  }
  return null;
}

/**
 * Состояние машинного pre-commit у потребителя:
 *   { repo, live, via, dormant } — есть ли репозиторий · видит ли git хук · откуда · и не лежит
 *   ли хук ФАЙЛОМ мимо git'а (типовой случай: `.husky/pre-commit` есть, а `prepare` не выполнен,
 *   то есть машина выглядит установленной, но не работает — молчаливая деградация).
 */
export function precommitStatus(cwd) {
  const gitDir = gitDirOf(cwd);
  if (!gitDir) return { repo: false, live: false, via: null, dormant: null };
  const configured = hooksPathOf(gitDir);
  const candidates = [
    ...(configured
      ? [{ dir: resolve(cwd, configured), via: `core.hooksPath = ${configured}` }]
      : []),
    { dir: join(gitDir, "hooks"), via: ".git/hooks/pre-commit" },
  ];
  for (const c of candidates)
    if (existsSync(join(c.dir, "pre-commit")))
      return { repo: true, live: true, via: c.via, dormant: null };
  const husky = join(cwd, ".husky", "pre-commit");
  return {
    repo: true,
    live: false,
    via: null,
    dormant: existsSync(husky) ? ".husky/pre-commit" : null,
  };
}

/** Отчёт по машинному pre-commit: строки для печати. */
export function precommitReport(cwd, { ok, bad, warn }) {
  const s = precommitStatus(cwd);
  if (!s.repo) return [warn("git-репозиторий не найден — про машинный pre-commit сказать нечего")];
  if (s.live) return [ok(`машинный pre-commit подключён (${s.via})`)];
  const lines = s.dormant
    ? [
        bad(`машинный pre-commit НЕ работает: файл ${s.dormant} есть, но git его не видит`),
        "    (`core.hooksPath` не настроен — установка инструмента не доведена до конца).",
      ]
    : [bad("машинного pre-commit НЕТ — коммит в этом репозитории не проверит никто")];
  lines.push(
    "    Рамка требует зелёный pre-commit (test+lint+build) — это ТРЕБОВАНИЕ К ПРОДУКТУ, а не",
    "    обещание обвеса: git-хуки твоя территория, и обвес их не везёт. Заведи машину сам",
    "    (`npx husky init` · `lefthook install` · `pre-commit install`) — до тех пор каденс",
    "    держится на агенте: test/lint/build руками перед каждым коммитом.",
  );
  return lines;
}

// --- отчёт -------------------------------------------------------------------

export function report(cwd, moduleUrl) {
  const out = [];
  const p = (s = "") => out.push(s);
  const ok = (s) => `  ✓ ${s}`;
  const bad = (s) => `  ✗ ${s}`;
  const warn = (s) => `  ⚠ ${s}`;

  p("harness doctor — проверка установки");
  p(`repo (cwd): ${cwd}`);
  p("");

  // --- конфиг ----------------------------------------------------------------
  const yamlPath = join(cwd, ".claude", "harness.yaml");
  let raw = null;
  try {
    raw = parseYaml(readFileSync(yamlPath, "utf8"));
  } catch {
    raw = null;
  }
  const config = loadConfig(cwd);

  if (!raw) {
    p(bad(".claude/harness.yaml не найден/не читается"));
    p("    → main-сессия заведётся на дефолте; owner-сессии НЕ смогут стартовать (нет зон).");
  } else {
    p(ok(".claude/harness.yaml прочитан"));
    const av = raw.apiVersion ?? "(нет)";
    const kind = raw.kind ?? "(нет)";
    p(`    apiVersion: ${av} · kind: ${kind}  (справочно — станком не валидируются)`);
  }
  p("");

  // --- продукт ---------------------------------------------------------------
  // Плейсхолдер шаблона — НЕ заполненный продукт. Раньше здесь стояла зелёная галочка на
  // `my-product`, пока баннер тот же конфиг уводил в онбординг: два инструмента говорили про
  // одно состояние разное, причём зелёный был у того, которым установку ПРОВЕРЯЮТ (BRAIN2-46 §1).
  if (needsOnboarding(config)) {
    p(
      warn(
        config.product
          ? `продукт: ${config.product} — это ПЛЕЙСХОЛДЕР шаблона (\`${PLACEHOLDER_PRODUCT}\`), сид не заполнен`
          : "продукт не задан (`product:` пуст) — сид не заполнен",
      ),
    );
    p("    → architect стартует в ОНБОРДИНГ-режим; owner'ов не поднимаем (зоны — placeholder).");
  } else {
    p(ok(`продукт: ${config.product}`));
  }
  p(`архитекторов сконфигурено: ${config.architects}`);
  // Слоты служб (tasker/knowledger/grabli/пилоты/чекпойнты) сняты 2026-08-24 вместе с самими
  // службами. Доктор про них молчит намеренно: строка «не сконфигурено» про то, чего не
  // существует, читается как недоделка и раз за разом посылает чинить несуществующее.
  p("");

  // --- зоны ------------------------------------------------------------------
  const rejected = rejectedZoneNames(raw?.zones);
  if (rejected.length) {
    p(bad(`зоны с зарезервированными именами ОТВЕРГНУТЫ: ${rejected.join(", ")}`));
    p("    → переименуй (main/layer — служебные слова роль-модели).");
  }
  const zones = Object.entries(config.zones);
  if (!zones.length) {
    p(warn("зон нет — owner-сессии стартовать не смогут (только architect/main)"));
  } else {
    p(`зоны (${zones.length}):`);
    for (const [name, z] of zones) {
      const paths = zonePaths(z);
      if (!paths.length) {
        p(bad(`${name} → нет путей (пустой paths[])`));
        continue;
      }
      p(`  ${name}:`);
      for (const path of paths) {
        const exists = existsSync(join(cwd, path));
        p(`    ${exists ? "✓" : "✗"} ${path}${exists ? "" : "   ПАПКИ НЕТ (boundary на пустоту)"}`);
      }
    }
  }
  // Конфиг объявляет зоны, которых здесь нет НИ ОДНОЙ → он не от этого репозитория.
  // Отметки «ПАПКИ НЕТ» были и раньше по каждой зоне — но их никто не складывал в вывод.
  const reality = zoneReality(config, cwd);
  if (reality.foreign) {
    p("");
    p(bad("КОНФИГ, ПОХОЖЕ, НЕ ОТ ЭТОГО РЕПОЗИТОРИЯ"));
    p(`    объявлено путей: ${reality.declared}, существует: 0 — ни одной зоны здесь нет.`);
    p(
      `    Так выглядит harness.yaml, скопированный из соседнего продукта${config.product ? ` (\`product: ${config.product}\`)` : ""}:`,
    );
    p("    имя продукта, роадмап и зоны в нём — чужие. Проверь с user, прежде чем работать.");
  } else if (reality.declared && reality.present < reality.declared) {
    p(
      warn(
        `папок нет у ${reality.declared - reality.present} из ${reality.declared} объявленных путей — boundary на пустоту`,
      ),
    );
  }
  // Валидатор роль-модели (relative / непустой) — kb:BRAIN2-1.
  const cfgErrors = validateConfig(config);
  if (cfgErrors.length) {
    p("");
    p(bad(`валидатор роль-модели: ${cfgErrors.length} ошибок`));
    for (const e of cfgErrors) p(`    - ${e}`);
  } else if (zones.length) {
    p(ok("валидатор роль-модели: пути относительные и непустые"));
  }
  // Совпадение путей — НЕ ошибка конфига, но и не защита: governance пускает обоих владельцев.
  // Вложенность — отдельный случай и с 2026-09-18 штатная механика, а не дыра: владелец
  // определяется самым длинным совпавшим путём. Печатать их одинаково значило бы звать чинить
  // то, что работает как задумано.
  const overlaps = overlappingZones(config);
  const equal = overlaps.filter((o) => o.kind === "equal");
  const nested = overlaps.filter((o) => o.kind === "nested");
  if (equal.length) {
    p(warn(`пути зон СОВПАДАЮТ (${equal.length}) — машинной границы между ними НЕТ:`));
    for (const o of equal)
      p(`    - "${o.zones[0]}" ↔ "${o.zones[1]}": "${o.paths[0]}" ↔ "${o.paths[1]}"`);
    p("    Задумано так (несколько ролей над одними файлами) — это законная раскладка.");
    p("    Не задумано — разведи paths[], иначе владельца у этих файлов машинно нет.");
  }
  if (nested.length) {
    p(ok(`вложенных зон: ${nested.length} — владелец по самому длинному пути:`));
    for (const o of nested) p(`    - "${o.paths[0]}" → ${o.zones[0]} (внутри ${o.zones[1]})`);
  }
  p("");

  // --- регистрация хуков (цена класса placed-once, см. шапку) ----------------
  for (const line of registrationReport(cwd, moduleUrl, { ok, bad, warn })) p(line);
  p("");

  // --- машинный pre-commit (BRAIN2-64: рамка его требует, обвес его не везёт) -
  for (const line of precommitReport(cwd, { ok, bad, warn })) p(line);
  p("");

  // --- текущий scope ---------------------------------------------------------
  const scope = process.env.HARNESS_SCOPE;
  if (!scope) {
    p("HARNESS_SCOPE не задан — запусти `HARNESS_SCOPE=main|<zone> ...` чтобы увидеть роль.");
    p(`доступные scope: ${knownScopes(config).join(", ")}`);
  } else {
    const resolved = resolveScope(scope, config);
    if (scope === "main") {
      p(ok(`HARNESS_SCOPE=main → architect (git: ${gitAccess("main", config)})`));
    } else if (resolved?.kind === "zone") {
      p(
        ok(
          `HARNESS_SCOPE=${scope} → owner-${scope} (git: ${gitAccess(scope, config)}), папки: ${resolved.paths.map((x) => `${x}/`).join(", ")}`,
        ),
      );
    } else {
      p(bad(`HARNESS_SCOPE=${scope} НЕ резолвится в зону (роль: ${roleOf(scope)})`));
      p(`    доступные: ${knownScopes(config).join(", ")}`);
    }
  }
  p("");

  // --- marker ----------------------------------------------------------------
  const marker = join(cwd, ".claude", ".main-session-id");
  try {
    const ids = readFileSync(marker, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    p(ok(`marker .claude/.main-session-id есть (${ids.length} активн. main-сессий)`));
  } catch {
    p(`  · marker .claude/.main-session-id нет (появится на SessionStart architect-сессии)`);
  }

  return out.join("\n");
}

// main() ТОЛЬКО как скрипт — при import (тесты) не запускается.
if (fileURLToPath(import.meta.url) === argv[1]) {
  process.stdout.write(`${report(process.cwd(), import.meta.url)}\n`);
}
