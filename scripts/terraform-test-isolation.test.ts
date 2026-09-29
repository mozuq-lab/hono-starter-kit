import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// module の tests は各ディレクトリーの tfvars を読むが、置く運用がないので対象外にする。
const roots = ["infra/terraform/environments/dev", "infra/terraform/bootstrap"];

type Literal = string | number | boolean | null;

// tfvars や -var が tftest に紛れ込むと、既定値を前提にした assert が環境ごとに変わる。
// 全変数を file-level で固定して、tfvars を切り離す。
function parseLiteral(root: string, name: string, raw: string): Literal {
  const text = raw.replace(/\s+(\/\/|#).*$/u, "").trim();
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/u.test(text)) return Number(text);
  if (/^"[^"\\$]*"$/u.test(text)) return JSON.parse(text) as string;
  assert.fail(
    `${root}: ${name} の値 ${text} は HCL のリテラルではない。比較を足すこと`,
  );
}

async function readDeclaredVariables(root: string) {
  const source = await readFile(
    path.join(repositoryRoot, root, "variables.tf"),
    "utf8",
  );
  const declared = new Map<string, { defaultRaw: string | undefined }>();
  let current: { name: string; defaultRaw: string | undefined } | undefined;
  for (const line of source.split("\n")) {
    const opened = /^variable\s+"([^"]+)"\s*\{/u.exec(line);
    if (opened) {
      current = { name: opened[1]!, defaultRaw: undefined };
      declared.set(current.name, current);
      continue;
    }
    // block 直下（インデント2）の default だけを拾い、validation 内の式は無視する。
    const defaultLine = /^ {2}default\s*=\s*(.*)$/u.exec(line);
    if (current && defaultLine) current.defaultRaw = defaultLine[1]!;
  }
  assert.ok(declared.size > 0, `${root}/variables.tf に変数がない`);
  return declared;
}

function readFileLevelVariables(source: string) {
  const match = /^variables\s*\{\n([\s\S]*?)^\}/mu.exec(source);
  assert.ok(match, "file-level の variables ブロックがない");
  const pinned = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const entry = /^\s+([a-z_0-9]+)\s*=\s*(.*)$/u.exec(line);
    if (entry) pinned.set(entry[1]!, entry[2]!);
  }
  return pinned;
}

async function readTestFiles(root: string) {
  const directory = path.join(repositoryRoot, root, "tests");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".tftest.hcl"))
    .sort();
  assert.ok(names.length > 0, `${root}/tests に tftest がない`);
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(path.join(directory, name), "utf8"),
    })),
  );
}

for (const root of roots) {
  test(`${root} tests pin every root variable`, async () => {
    const declared = await readDeclaredVariables(root);
    for (const file of await readTestFiles(root)) {
      const pinned = readFileLevelVariables(file.source);
      for (const name of declared.keys()) {
        assert.ok(
          pinned.has(name),
          `${file.name}: file-level variables に ${name} がない`,
        );
      }
    }
  });

  test(`${root} tests pin variables to their declared defaults`, async () => {
    const declared = await readDeclaredVariables(root);
    for (const file of await readTestFiles(root)) {
      const pinned = readFileLevelVariables(file.source);
      for (const [name, { defaultRaw }] of declared) {
        if (defaultRaw === undefined) continue;
        const pinnedRaw = pinned.get(name);
        assert.ok(pinnedRaw !== undefined, `${file.name}: ${name} が未固定`);
        assert.equal(
          parseLiteral(`${root}/tests/${file.name}`, name, pinnedRaw),
          parseLiteral(`${root}/variables.tf`, name, defaultRaw),
          `${file.name}: ${name} の固定値が variables.tf の default と違う`,
        );
      }
    }
  });
}
