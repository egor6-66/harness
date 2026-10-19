// node --test hooks/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { outsideRepo } from "./repo-boundary.mjs";
import { foreignRepoWrite } from "./git-gate.mjs";

const hooks = dirname(fileURLToPath(import.meta.url));

/** Скоуп из двух репозиториев рядом: `app` (с роль-моделью) и `base`; `app` линкует пакет `base`. */
function scope() {
  // Не в tmpdir: временная папка разрешена хуку целиком, и проба на ней ничего бы не доказала.
  const root = realpathSync(mkdtempSync(join(hooks, ".scope-")));
  for (const repo of ["app", "base"]) {
    mkdirSync(join(root, repo, ".claude"), { recursive: true });
    execFileSync("git", ["init", "-q", join(root, repo)]);
  }
  writeFileSync(join(root, "app", ".claude", "harness.yaml"), "apiVersion: harness/v1\n");
  mkdirSync(join(root, "base", "ui"));
  mkdirSync(join(root, "app", "node_modules", "@base"), { recursive: true });
  symlinkSync(join(root, "base", "ui"), join(root, "app", "node_modules", "@base", "ui"));
  return { root, app: join(root, "app"), base: join(root, "base") };
}

function runHook(name, input, env) {
  const out = execFileSync(process.execPath, [join(hooks, name)], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
  }).toString();
  return JSON.parse(out).hookSpecificOutput?.permissionDecision ?? "pass";
}

test("правка в своём репозитории проходит, в соседнем — нет", () => {
  const { app, base } = scope();
  const allowed = [];
  assert.equal(outsideRepo({ target: join(app, "src", "a.ts"), repoRoot: app, allowed }), null);
  assert.match(outsideRepo({ target: join(base, "ui", "a.ts"), repoRoot: app, allowed }), /вне репозитория/);
  assert.match(outsideRepo({ target: join(app, "..", "base", "a.ts"), repoRoot: app, allowed }), /вне/);
});

test("правка через линк в node_modules — правка соседа", () => {
  const { app } = scope();
  const viaLink = join(app, "node_modules", "@base", "ui", "index.ts");
  assert.match(outsideRepo({ target: viaLink, repoRoot: app, allowed: [] }), /base/);
});

test("служебные папки вне репозитория разрешены", () => {
  const { app, root } = scope();
  const memory = join(root, "config", "projects", "memory.md");
  assert.equal(outsideRepo({ target: memory, repoRoot: app, allowed: [join(root, "config")] }), null);
});

test("хук: соседний репозиторий — deny, свой — без вердикта, без роль-модели — молчит", () => {
  const { app, base } = scope();
  const edit = (file, project) =>
    runHook(
      "repo-boundary.mjs",
      { tool_name: "Edit", tool_input: { file_path: file }, cwd: project },
      { CLAUDE_PROJECT_DIR: project },
    );
  assert.equal(edit(join(base, "ui", "a.ts"), app), "deny");
  assert.equal(edit(join(app, "src", "a.ts"), app), "pass");
  // В `base` роль-модели нет — границу проводить не от чего.
  assert.equal(edit(join(app, "src", "a.ts"), base), "pass");
  assert.equal(
    runHook(
      "repo-boundary.mjs",
      { tool_name: "NotebookEdit", tool_input: { notebook_path: join(base, "n.ipynb") }, cwd: app },
      { CLAUDE_PROJECT_DIR: app },
    ),
    "deny",
  );
});

test("git-запись в соседний репозиторий видна через cd, -C, --git-dir и bash -c", () => {
  const { app, base } = scope();
  const write = (cmd) => foreignRepoWrite({ cmd, cwd: app, repoRoot: app });
  for (const cmd of [
    "cd ../base && git commit -m x",
    "git -C ../base add .",
    `git --git-dir=${base}/.git commit -m x`,
    "bash -c 'cd ../base; git push'",
    "cd .. && cd base && git reset --hard",
  ]) {
    assert.equal(write(cmd)?.target, base, cmd);
  }
  for (const cmd of [
    "git commit -m x",
    "git -C ../base log --oneline",
    "cd ../base && git status",
    "cd ../base && ls; cd ../app && git commit -m x",
  ]) {
    assert.equal(write(cmd), null, cmd);
  }
});

test("git-gate: запись в соседний репозиторий — deny даже architect'у", () => {
  const { app } = scope();
  const decision = runHook(
    "git-gate.mjs",
    { tool_name: "Bash", tool_input: { command: "cd ../base && git commit -m x" }, cwd: app, session_id: "s" },
    { CLAUDE_PROJECT_DIR: app, HARNESS_SCOPE: "main" },
  );
  assert.equal(decision, "deny");
});
