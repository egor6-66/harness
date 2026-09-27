// harness-config.mjs — единый источник роль-модели как ДАННЫХ: читает `.claude/harness.yaml`
// и отдаёт хукам зоны/пути, пины моделей, число архитекторов, git-доступ по роли. Ноль
// хардкода зон.
//
// ДОМ ФАЙЛА СМЕНИЛСЯ (2026-08-24). Раньше конфиг лежал в папке станка, который клал его сюда
// сидом. Станка больше нет, и держать живой файл в его папке значило бы поминать покойника
// при каждой правке. Вместе с домом сняты слоты, адресовавшие
// службы, которых тоже не стало: `services`, `checkpoints`, `grabli`, `pilots`. Обвес больше
// не рассказывает сессии, куда ходить, — он отвечает только за то, что проверяет машиной.
//
// Зависимостей нет (хуки Claude Code стартуют голым node). YAML парсится подмножеством
// (scalar + вложенные map'ы + inline flow-массив `[a, b]` для paths[] — ровно то, что нужно
// harness.yaml; block-list `- x` не поддерживаем).
// Файла нет → DEFAULT_CONFIG (degraded, но безопасный: только 'main'/architect известен,
// зоны пусты → неизвестный scope = аномалия; git по роли — инвариант рамки).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Инвариант рамки (shared-policy) — НЕ продуктовые данные: git-доступ по роли не выключить.
// Значения оверрайдятся конфигом, но роль-семантика (что именно режется) — в git-gate.
const GIT_INVARIANT = { architect: "full", owner: "commit-only", layer: "none" };

// Дефолт-пины моделей по роли (ПРЕСЕТ, MECH-7): применяются, если продукт не переопределил
// `models:` в harness.yaml. architect и owner — сильнейшая (opus-5), layer — haiku (узкий
// одноартефактный промпт). Продукт крутит конфигом; это разумный дефолт, не инвариант.
// АЛИАСЫ, а не снапшоты с датой: алиас едет за выпусками сам, снапшот замораживает сессии
// на конкретной сборке. Держать синхронно с сидом (harness.config.example.yaml).
const MODEL_DEFAULTS = {
  architect: "claude-opus-5",
  owner: "claude-opus-5",
  layer: "claude-haiku-4-5",
};

// Зарезервированные слова роль-модели: 'main' = architect, 'layer' = layer-роль. Зона с таким
// именем даёт двоемыслие (баннер owner commit-only, а git-gate по roleOf режет как layer/none) —
// поэтому такие зоны ОТВЕРГАЕМ при чтении конфига (scope тогда не резолвится → честная аномалия).
const RESERVED_ZONE_NAMES = new Set(["main", "layer"]);

export const DEFAULT_CONFIG = {
  product: null,
  architects: 1,
  models: { ...MODEL_DEFAULTS },
  zones: {},
  git: { ...GIT_INVARIANT },
};

/** Коэрция скалярного YAML-значения: quotes strip, int, bool, иначе строка. */
function coerce(raw) {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

/**
 * Коэрция значения: inline flow-массив `[a, b, c]` → массив коэрцированных элементов
 * (пустой `[]` → `[]`, хвостовая запятая отбрасывается); иначе — скаляр через coerce.
 * Нужно для `zones.<z>.paths: [web-core/a, web-core/b]` (BRAIN2-1). Block-list (`- x`)
 * не поддерживаем — в harness.yaml его нет.
 */
function coerceValue(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => coerce(x))
      .filter((x) => x !== "");
  }
  return coerce(v);
}

/**
 * Мини-парсер YAML-подмножества: отступ = 2 пробела/уровень; `key:` → вложенный map;
 * `key: value` → скаляр или inline flow-массив `[a, b]` (см. coerceValue). Комментарии
 * (`# …`), пустые строки и `---` игнорятся. Block-list (`- x`) НЕ поддерживается.
 */
export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    const ci = trimmed.indexOf(":");
    if (ci === -1) continue; // не key:value (списков не ждём) — пропуск
    const indent = rawLine.length - rawLine.trimStart().length;
    const key = trimmed.slice(0, ci).trim();
    let val = trimmed.slice(ci + 1).trim();
    // Хвостовой inline-комментарий (YAML: пробел + `#`) на НЕ-quoted скаляре — отрезаем,
    // иначе `product: x  # note` уезжает в значение целиком. `a/b#c` (без пробела) — НЕ коммент.
    if (val && !val.startsWith('"') && !val.startsWith("'")) {
      const h = val.search(/\s#/);
      if (h !== -1) val = val.slice(0, h).trim();
      else if (val.startsWith("#")) val = "";
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = coerceValue(val);
    }
  }
  return root;
}

/** Зоны из конфига без зарезервированных имён (main/layer). Пустой/не-объект → {}. */
export function normalizeZones(rawZones) {
  if (!rawZones || typeof rawZones !== "object") return {};
  return Object.fromEntries(Object.entries(rawZones).filter(([k]) => !RESERVED_ZONE_NAMES.has(k)));
}

/** Имена зон, отвергнутые как зарезервированные (для doctor/диагностики). */
export function rejectedZoneNames(rawZones) {
  if (!rawZones || typeof rawZones !== "object") return [];
  return Object.keys(rawZones).filter((k) => RESERVED_ZONE_NAMES.has(k));
}

/** Достраивает распарсенный конфиг дефолтами по отсутствующим секциям. */
export function normalizeConfig(parsed) {
  const c = parsed && typeof parsed === "object" ? parsed : {};
  return {
    product: typeof c.product === "string" ? c.product : DEFAULT_CONFIG.product,
    architects: typeof c.architects === "number" ? c.architects : DEFAULT_CONFIG.architects,
    models: { ...MODEL_DEFAULTS, ...(c.models && typeof c.models === "object" ? c.models : {}) },
    zones: normalizeZones(c.zones),
    git: { ...GIT_INVARIANT, ...(c.git && typeof c.git === "object" ? c.git : {}) },
  };
}

/**
 * Читает `.claude/harness.yaml` из cwd; нет файла/парс упал → DEFAULT_CONFIG.
 *
 * Деградация БЕЗОПАСНА, но НЕ безобидна: зоны пусты → ни один owner-scope не резолвится, и
 * governance режет ему всякую правку («boundary неизвестна»). Это верное поведение — владелец
 * без границы опаснее владельца без прав, — но означает, что пропажу файла увидит первым
 * овнер, а не тот, кто её устроил. Поэтому её отдельно называет doctor.
 */
export function loadConfig(cwd = process.cwd()) {
  try {
    const text = readFileSync(join(cwd, ".claude", "harness.yaml"), "utf8");
    return normalizeConfig(parseYaml(text));
  } catch {
    return { ...DEFAULT_CONFIG, git: { ...GIT_INVARIANT } };
  }
}

/** Роль по scope: main→architect; 'layer'→layer; иначе (зона) → owner. */
export function roleOf(scope) {
  if (scope === "main") return "architect";
  if (scope === "layer") return "layer";
  return "owner";
}

/** Git-доступ (full|commit-only|none) для scope — из config.git[role], иначе инвариант. */
export function gitAccess(scope, config) {
  const role = roleOf(scope);
  return config?.git?.[role] ?? GIT_INVARIANT[role] ?? "none";
}

/**
 * Пути зоны как МАССИВ (BRAIN2-1: один owner владеет несколькими папками). Толерантный
 * ридер: `paths: [a, b]` (канон) ∪ legacy одиночный `path:` ∪ голая строка `zone: path`
 * → всегда массив относительных путей. Пустые/не-строки отбрасываются.
 */
export function zonePaths(zone) {
  if (!zone) return [];
  if (typeof zone === "string") return zone ? [zone] : [];
  const raw = Array.isArray(zone.paths)
    ? zone.paths
    : typeof zone.path === "string"
      ? [zone.path]
      : [];
  return raw.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim());
}

/** true, если путь `a` равен `b` или вложен в него (по сегментам): a === b || b + '/' — префикс a. */
function nestedOrEqual(a, b) {
  return a === b || a.startsWith(`${b}/`);
}

/** Нормализация относительного пути для сравнения: срезаем ведущий `./` и хвостовой `/`. */
function normPath(p) {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Детерминированный валидатор роль-модели (BRAIN2-1, канон schema-validated из kb:BRAIN2-3):
 * каждая зона — непустой набор ОТНОСИТЕЛЬНЫХ путей (не абсолют, без `..`-escape). Возвращает
 * массив строк-ошибок (пустой = валидно). Не бросает — вызыватели решают, что делать.
 *
 * Пересечение путей разных зон ошибкой ЗДЕСЬ НЕ СЧИТАЕТСЯ и живёт отдельно —
 * `overlappingZones()`. Причина: `governance` конфиг не валидирует и правку в пересечении
 * пускает, так что «одна папка — один владелец» было обещанием защиты, которой нет
 * (BRAIN2-46 §4). Механику не трогаем — перестаём врать: это раскладка, а не ошибка.
 */
export function validateConfig(config) {
  const errors = [];
  for (const [zone, def] of Object.entries(config?.zones ?? {})) {
    const paths = zonePaths(def);
    if (!paths.length) {
      errors.push(`зона "${zone}": нет путей (ожидается непустой paths[])`);
      continue;
    }
    for (const raw of paths) {
      const p = normPath(raw);
      if (raw.startsWith("/"))
        errors.push(`зона "${zone}": путь "${raw}" абсолютный (нужен относительный)`);
      else if (p === "" || p.split("/").includes(".."))
        errors.push(`зона "${zone}": путь "${raw}" невалиден (пустой или содержит "..")`);
    }
  }
  return errors;
}

/** Резолв scope → зона (из ДАННЫХ конфига). main → architect; unknown → null (аномалия). */
export function resolveScope(scope, config) {
  if (scope === "main") return { kind: "main", scope: "main", role: "architect" };
  const zone = config?.zones?.[scope];
  if (!zone) return null;
  const description =
    typeof zone === "object" && !Array.isArray(zone) ? zone.description : undefined;
  const paths = zonePaths(zone);
  return {
    kind: "zone",
    scope,
    role: "owner",
    paths,
    name: description ? `${scope} — ${description}` : scope,
  };
}

/** Список известных scope'ов (для аномалий/CLI). */
export function knownScopes(config) {
  return ["main", ...Object.keys(config?.zones ?? {})];
}

/**
 * Расстояние Дамерау—Левенштейна, вариант с СОСЕДНИМИ перестановками (OSA): вставка ·
 * удаление · замена · перестановка соседей — каждая ценой 1. Перестановка самый частый класс
 * человеческой опечатки, и по коротким именам зон промахиваются именно так: на чистом
 * Левенштейне `mian` против `main` стоило две правки и в порог не попадало.
 * Полный unrestricted-вариант тут не нужен — этого класса достаточно.
 *
 * Двадцать строк внутри вместо готовой либы — осознанно: обвес ставится в ЧУЖИЕ репозитории,
 * и ноль зависимостей у него дороже (решение architect, ).
 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Перестановка соседей ("mian" ↔ "main") — ОДНА правка, а не две.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, prev2[j - 2] + cost);
      row[j] = best;
    }
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Ближайшие по написанию scope'ы — подсказка на ОПЕЧАТКУ (механика рынка: git `help.autocorrect`,
 * cargo, npm/commander — везде Левенштейн с порогом около трети длины набранного, сверено
 * 2026-08-01). Порог держим тем же: подсказываем только уверенно близкое, иначе подсказка врёт.
 * Ноль кандидатов — не гадаем; несколько — выбор за человеком, за него не решаем.
 */
export function nearestScopes(scope, config) {
  const typed = String(scope ?? "")
    .trim()
    .toLowerCase();
  if (!typed) return [];
  const limit = Math.max(1, Math.floor(typed.length / 3));
  return knownScopes(config)
    .map((s) => ({ s, d: editDistance(typed, s.toLowerCase()) }))
    .filter(({ d }) => d <= limit)
    .sort((a, b) => a.d - b.d || a.s.localeCompare(b.s))
    .map(({ s }) => s);
}

// --- состояние установки: одно знание на баннер и на диагностику ------------
// Тут живут признаки, по которым инструменты судят о конфиге. Раньше про плейсхолдер знал
// только баннер, а доктор ставил на него зелёную галочку — два инструмента говорили про одно
// состояние разное, причём зелёный был у того, которым установку ПРОВЕРЯЮТ (BRAIN2-46 §1).

/** Плейсхолдер продукта из нейтрального шаблона сида. */
export const PLACEHOLDER_PRODUCT = "my-product";

/**
 * Сид не заполнен под продукт: `product` пуст/отсутствует ИЛИ равен плейсхолдеру шаблона.
 * Тогда architect стартует в ОНБОРДИНГ-режим, а доктор говорит «шаблон», а не «✓ продукт».
 */
export function needsOnboarding(config) {
  return !config?.product || config.product === PLACEHOLDER_PRODUCT;
}

/**
 * Сверка объявленных зон с диском: какие пути реально существуют в этом репозитории.
 * `foreign` — зоны объявлены, но НИ ОДИН путь не существует: это не «зоны пустые», а
 * «конфиг не от этого репозитория» (скопирован из соседнего продукта). Признак был в
 * данных и раньше — доктор печатал «ПАПКИ НЕТ» по каждой зоне, — но никто не складывал
 * отметки в вывод, а баннер существование папок не смотрел вовсе (BRAIN2-46 §2).
 */
export function zoneReality(config, cwd = process.cwd()) {
  const rows = [];
  for (const [zone, def] of Object.entries(config?.zones ?? {})) {
    for (const path of zonePaths(def)) {
      rows.push({ zone, path, exists: existsSync(join(cwd, path)) });
    }
  }
  const present = rows.filter((r) => r.exists).length;
  return { rows, declared: rows.length, present, foreign: rows.length > 0 && present === 0 };
}

/**
 * Пары зон, чьи пути сходятся. ДВА РАЗНЫХ СЛУЧАЯ, и смешивать их нельзя:
 *
 * - `kind: "equal"` — пути СОВПАДАЮТ. Машинной границы между такими зонами нет и быть не может:
 *   `governance` пустит обоих владельцев в один файл, и от взаимного затирания не защищает
 *   ничто (BRAIN2-46 §4). Это раскладка, а не ошибка конфига, но знать о ней обязаны оба.
 * - `kind: "nested"` — один путь ЛЕЖИТ ВНУТРИ другого. С 2026-09-18 это штатное делегирование,
 *   а не дыра: владельцем считается зона с самым длинным совпавшим путём (`outsideOwnership`
 *   в governance), то есть вложенная папка принадлежит вложенной зоне, и родительская в неё
 *   не пройдёт. Так разведены `apps/studio` (studio-app) и `apps/studio/.mcp` (studio-mcp).
 */
export function overlappingZones(config) {
  const owned = [];
  for (const [zone, def] of Object.entries(config?.zones ?? {})) {
    for (const raw of zonePaths(def)) {
      const p = normPath(raw);
      if (!raw.startsWith("/") && p !== "" && !p.split("/").includes("..")) owned.push({ zone, p });
    }
  }
  const pairs = [];
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      const a = owned[i];
      const b = owned[j];
      if (a.zone === b.zone) continue;
      if (a.p === b.p) {
        pairs.push({ kind: "equal", zones: [a.zone, b.zone], paths: [a.p, b.p] });
      } else if (nestedOrEqual(a.p, b.p) || nestedOrEqual(b.p, a.p)) {
        // Внутренняя зона первой — так пара читается как «X вложена в Y».
        const inner = a.p.length > b.p.length ? a : b;
        const outer = inner === a ? b : a;
        pairs.push({
          kind: "nested",
          zones: [inner.zone, outer.zone],
          paths: [inner.p, outer.p],
        });
      }
    }
  }
  return pairs;
}
