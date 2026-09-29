import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// package.json をこのファイルが読む範囲だけの形として受ける。読み取りは 6 か所あり、
// どれも同じ文書を見ているので、形の宣言もここに 1 つだけ置く。
type WorkspaceManifest = {
  engines: Record<string, string>;
  packageManager: string;
  devEngines: {
    packageManager: { name: string; version: string; onFail: string };
  };
  scripts: Record<string, string>;
};

const readWorkspaceManifest = async () =>
  JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as WorkspaceManifest;

// Renovate が version を上げても落ちないよう、バージョン番号は packageManager を
// 唯一の正として、他の宣言がそれと一致することだけを確かめる。
const pinnedPnpmVersion = (manifest: WorkspaceManifest) => {
  const match = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(manifest.packageManager);
  assert.ok(match, "packageManager must be pnpm@<semver>");
  return match[1]!;
};

test("workspace requires Node 24 or newer without a Corepack ceiling", async () => {
  const manifest = await readWorkspaceManifest();

  assert.equal(manifest.engines.node, ">=24");
});

test("pnpm version pins derive from packageManager", async () => {
  const manifest = await readWorkspaceManifest();
  const version = pinnedPnpmVersion(manifest);

  assert.equal(manifest.engines.pnpm, version);
  assert.deepEqual(manifest.devEngines.packageManager, {
    name: "pnpm",
    version,
    onFail: "download",
  });
});

test("no workspace script invokes Corepack", async () => {
  const manifest = await readWorkspaceManifest();
  const offending = Object.entries(manifest.scripts)
    .filter(([, command]) => command.includes("corepack"))
    .map(([name]) => name);

  assert.deepEqual(offending, []);
});

const containerDefinitions = [
  "../compose.yaml",
  "../docker/node-dev.Dockerfile",
  "../docker/api.Dockerfile",
];

test("no container definition invokes Corepack", async () => {
  const offending = [];
  for (const definition of containerDefinitions) {
    const contents = await readFile(
      new URL(definition, import.meta.url),
      "utf8",
    );
    if (contents.includes("corepack")) {
      offending.push(definition);
    }
  }

  assert.deepEqual(offending, []);
});

test("container images install the pinned pnpm version", async () => {
  const version = pinnedPnpmVersion(await readWorkspaceManifest());
  const images = ["../docker/node-dev.Dockerfile", "../docker/api.Dockerfile"];
  const missing = [];
  for (const image of images) {
    const contents = await readFile(new URL(image, import.meta.url), "utf8");
    if (!contents.includes(`npm install --global pnpm@${version}\n`)) {
      missing.push(image);
    }
  }

  assert.deepEqual(missing, []);
});

test("every Dockerfile and .node-version agree on the Node version", async () => {
  const nodeVersion = (
    await readFile(new URL("../.node-version", import.meta.url), "utf8")
  ).trim();
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/u);

  const dockerfiles = (
    await readdir(new URL("../docker/", import.meta.url))
  ).filter((name) => name.endsWith(".Dockerfile"));
  assert.notEqual(dockerfiles.length, 0);
  const mismatched = [];
  for (const dockerfile of dockerfiles) {
    const contents = await readFile(
      new URL(`../docker/${dockerfile}`, import.meta.url),
      "utf8",
    );
    for (const match of contents.matchAll(/^FROM node:([^\s-]+)-/gmu)) {
      if (match[1] !== nodeVersion) {
        mismatched.push(`${dockerfile}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(mismatched, []);
});

test("no repository script invokes Corepack", async () => {
  const directory = new URL("./", import.meta.url);
  const entries = await readdir(directory, { recursive: true });
  // scripts/ が TypeScript になったので、走査対象も .ts に移す。ここを .mjs のままに
  // すると、対象が 1 つも無いまま常に通るテストになる。
  const scanned = entries.filter(
    (name) => name.endsWith(".ts") && name !== "runtime.test.ts",
  );
  const offending = [];
  for (const entry of scanned) {
    const contents = await readFile(new URL(entry, directory), "utf8");
    if (contents.includes("corepack")) {
      offending.push(entry);
    }
  }

  assert.deepEqual(offending.sort(), []);
});

test("the web E2E harness does not invoke Corepack", async () => {
  const harness = [
    "../apps/web/playwright.config.ts",
    "../apps/web/e2e/api-process.ts",
  ];
  const offending = [];
  for (const file of harness) {
    const contents = await readFile(new URL(file, import.meta.url), "utf8");
    if (/corepack/iu.test(contents)) {
      offending.push(file);
    }
  }

  assert.deepEqual(offending, []);
});

test("the README does not instruct operators to run Corepack", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );

  assert.equal(/corepack/iu.test(readme), false);
});

// docs/design.md が Corepack に言及するのは構わない。ワークスペースが依存をやめた理由を
// 記録しているため。載っていてはいけないのは、Corepack を経由する運用コマンドのほう。
test("docs/design.md documents no Corepack-routed operator command", async () => {
  const design = await readFile(
    new URL("../docs/design.md", import.meta.url),
    "utf8",
  );

  assert.equal(design.includes("corepack pnpm"), false);
});

test("lint refreshes workspace declarations before typed ESLint", async () => {
  const manifest = await readWorkspaceManifest();
  const lint = manifest.scripts.lint;

  assert.equal(typeof lint, "string");
  const typecheckIndex = lint!.indexOf("pnpm typecheck");
  const eslintIndex = lint!.indexOf("eslint .");
  assert.notEqual(typecheckIndex, -1);
  assert.notEqual(eslintIndex, -1);
  assert.ok(typecheckIndex < eslintIndex);
});

test("test script discovers node tests by glob", async () => {
  const manifest = await readWorkspaceManifest();
  const testScript = manifest.scripts.test;

  assert.equal(typeof testScript, "string");

  const contractsBuildIndex = testScript!.indexOf(
    "pnpm --filter @starter/contracts build",
  );
  const nodeTestsIndex = testScript!.indexOf("node --test");

  assert.notEqual(contractsBuildIndex, -1);
  assert.notEqual(nodeTestsIndex, -1);
  assert.ok(contractsBuildIndex < nodeTestsIndex);
  // 個別のファイル名を並べると、新しいテストが黙って実行されなくなる。
  assert.ok(testScript!.includes('"scripts/**/*.test.ts"'));
  assert.equal(
    /scripts\/[\w./-]+\.test\.ts/.test(
      testScript!.replace('"scripts/**/*.test.ts"', ""),
    ),
    false,
  );
});

test("terraform:check does not rerun node tests that the test script already discovers", async () => {
  const manifest = await readWorkspaceManifest();
  const terraformCheck = manifest.scripts["terraform:check"];

  assert.equal(typeof terraformCheck, "string");
  // pnpm test の glob（scripts/**/*.test.ts と infra/terraform/**/tests/*.test.mjs）が拾う
  // ファイルをここにも並べると、CI の check と terraform の両ジョブで同じテストが走る。
  assert.deepEqual(
    terraformCheck!.match(
      /(?:scripts\/[\w./-]+\.test\.ts|infra\/terraform\/[\w./-]*tests\/[\w.-]+\.test\.mjs)/gu,
    ) ?? [],
    [],
  );
  // glob に入らない acceptance だけは terraform:check が受け持つ。
  assert.ok(
    terraformCheck!.includes("scripts/terraform-foundation-plan.acceptance.ts"),
  );
});

test("check does not run typecheck outside lint", async () => {
  const manifest = await readWorkspaceManifest();

  assert.equal(manifest.scripts.check!.includes("pnpm typecheck"), false);
});
