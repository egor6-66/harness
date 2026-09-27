// ownership.mjs — кто владеет файлом по раскладке зон. Границу ПРАВКИ держат штатные правила
// доступа (файл роли, `.claude/roles/<роль>.json`), а этот модуль нужен там, где правилами не
// выразить: проверка СОСТАВА коммита. Разбор — README.md плагина.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { roleOf, zonePaths } from "./harness-config.mjs";

/**
 * Граница правок для scope: architect/layer → без ограничения; owner → корни zonePaths
 * (абсолютные, от repoRoot); нерезолвимая зона → ограничение с пустыми корнями (DENY всё).
 */
export function ownedRoots(scope, config, repoRoot) {
  const role = roleOf(scope);
  if (role === "architect" || role === "layer") return { unrestricted: true, roots: [] };
  // owner: зона должна резолвиться и иметь пути
  const zone = config?.zones?.[scope];
  const roots = zonePaths(zone).map((p) => resolve(repoRoot, p));
  return { unrestricted: false, roots };
}

/** true, если targetAbs === root или лежит ВНУТРИ него (по сегментам, без ложных префиксов). */
export function within(targetAbs, root) {
  if (targetAbs === root) return true;
  const rel = relative(root, targetAbs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Резолв цели в абсолютный путь с защитой от обхода: `..` сворачивается resolve'ом; симлинки —
 * realpath ближайшего существующего предка (файл может ещё не существовать при Write) + хвост.
 */
export function resolveTarget(rawPath, repoRoot) {
  const abs = resolve(repoRoot, rawPath);
  // realpath ближайшего существующего предка → ловит симлинк-папку, ведущую наружу зоны.
  let anc = abs;
  const tail = [];
  while (!existsSync(anc)) {
    const parent = dirname(anc);
    if (parent === anc) break; // дошли до корня FS
    tail.unshift(basename(anc)); // basename корректен и на руте (`/repo` → `repo`, не `epo`)
    anc = parent;
  }
  try {
    const real = realpathSync(anc);
    return tail.length ? join(real, ...tail) : real;
  } catch {
    return abs; // realpath упал — берём resolve-путь (fail-safe к строгой проверке ниже)
  }
}

/** Корни ЧУЖИХ зон (всех, кроме scope) — абсолютные, с именем зоны. */
export function foreignRoots(scope, config, repoRoot) {
  const out = [];
  for (const [zone, def] of Object.entries(config?.zones ?? {})) {
    if (zone === scope) continue;
    for (const p of zonePaths(def)) out.push({ zone, root: resolve(repoRoot, p) });
  }
  return out;
}

/**
 * Владельцем файла считается зона с САМЫМ ДЛИННЫМ совпавшим путём: вложенная зона выигрывает
 * у родительской.
 *
 * Без этого правила вложенность означала бы отсутствие границы. `apps/studio/.mcp` (зона
 * `studio-mcp`) лежит внутри `apps/studio` (зона `studio-app`), и по одному лишь `within`
 * владелец приложения проходил бы в MCP-сервер соседа как к себе домой — при том, что зоны
 * разводили ровно затем, чтобы у каждой папки был один владелец (решение user 2026-09-18).
 *
 * Причина отказа, либо null (файл наш).
 */
export function outsideOwnership({ target, scope, config, repoRoot }) {
  const owned = ownedRoots(scope, config, repoRoot);
  if (owned.unrestricted) return null;
  if (!owned.roots.length) {
    return `scope "${scope}" не резолвится в зону с путями — boundary неизвестна`;
  }
  const rel = relative(repoRoot, target) || target;
  const mine = owned.roots.filter((r) => within(target, r));
  if (!mine.length) {
    return `файл \`${rel}\` вне зоны owner-${scope} (${owned.roots.map((r) => `${relative(repoRoot, r)}/`).join(", ")})`;
  }
  // Наш корень совпал — но чужой мог совпасть ГЛУБЖЕ, и тогда файл принадлежит ему.
  const deepest = Math.max(...mine.map((r) => r.length));
  const nested = foreignRoots(scope, config, repoRoot).find(
    ({ root }) => root.length > deepest && within(target, root),
  );
  if (nested) {
    return `файл \`${rel}\` лежит в зоне owner-${nested.zone} (\`${relative(repoRoot, nested.root)}/\`), вложенной в твою — у вложенной папки свой владелец`;
  }
  return null;
}
