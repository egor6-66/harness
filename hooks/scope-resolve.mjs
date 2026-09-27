#!/usr/bin/env node
// scope-resolve.mjs — резолв scope → зона продукта, config-driven (зоны из
// `.claude/harness.yaml`, НЕ хардкод). Двойной режим:
//   - CLI:    `node scope-resolve.mjs <scope>` → stdout JSON, exit 0 (OK) | 1 (unknown).
//   - import: `import { resolveScope } from './scope-resolve.mjs'` (грузит конфиг из cwd).
//
// scope = leaf-имя зоны (либо 'main' = architect). Первоисточник зон — конфиг.

import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { knownScopes, loadConfig, resolveScope as resolveWithConfig } from "./harness-config.mjs";

/** Резолвит scope, читая зоны из конфига (по умолчанию — из cwd). */
export function resolveScope(scope, cwd = process.cwd()) {
  return resolveWithConfig(scope, loadConfig(cwd));
}

if (fileURLToPath(import.meta.url) === argv[1]) {
  const scope = argv[2];
  const config = loadConfig(process.cwd());
  const resolved = resolveWithConfig(scope, config);
  if (!resolved) {
    const list = knownScopes(config).join(", ");
    process.stderr.write(`ERROR: unknown scope "${scope}". Доступные: ${list}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(resolved));
  process.exit(0);
}
