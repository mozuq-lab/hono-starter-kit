import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assertAllowedCreateRequireExternals,
  assertAllowedRuntimeExternals,
  assertDevelopmentOnlyExternalsAreDynamic,
  assertDevelopmentOnlyModulesExcluded,
  buildApiRuntime,
  findBundledDevelopmentOnlyModules,
  findStaticDevelopmentOnlyExternals,
} from "./build-api-runtime.ts";

const execFileAsync = promisify(execFile);
const builtinSet = new Set(
  builtinModules.map((specifier) => specifier.replace(/^node:/u, "")),
);

// 実ビルドを流す最小ソースツリー。リポジトリを複製せずに本物の
// developmentOnlyRuntimeModules 登録内容を突き合わせるため、パス形状だけを再現する。
const withRuntimeSourceTree = async <Result>(
  files: Record<string, string>,
  run: (context: {
    build: (
      options?: Parameters<typeof buildApiRuntime>[0],
    ) => ReturnType<typeof buildApiRuntime>;
    root: string;
  }) => Promise<Result>,
) => {
  const root = await mkdtemp(join(tmpdir(), "starter-runtime-tree-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    return await run({
      build: (options: Parameters<typeof buildApiRuntime>[0] = {}) =>
        buildApiRuntime({
          entryPoints: { api: "apps/api-node/src/index.ts" },
          outdir: join(root, "out"),
          root,
          ...options,
        }),
      root,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const fixtureSource = "export const createFixturePersistence = () => ({});\n";
const entrySource = [
  'import { load } from "./runtime-composition.js";',
  "",
  "await load();",
  "",
].join("\n");

test("buildApiRuntime emits portable ESM entries with only allowed externals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-api-runtime-"));

  try {
    const result = await buildApiRuntime({ outdir: directory });

    assert.deepEqual(result.outputs.map((path) => basename(path)).sort(), [
      "api.mjs",
      "migrate.mjs",
    ]);
    for (const output of result.outputs) {
      await access(output);
      await execFileAsync(process.execPath, ["--check", output]);
    }
    await symlink(
      fileURLToPath(
        new URL("../docker/api-runtime/node_modules", import.meta.url),
      ),
      join(directory, "node_modules"),
      "dir",
    );
    // 構文検査だけでは、ESM bundle 内の CommonJS loader の実行時エラーを見落とす。
    await assert.rejects(
      execFileAsync(process.execPath, [join(directory, "api.mjs")], {
        env: { NODE_ENV: "production", AUTH_PROVIDER: "dev" },
        timeout: 10_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error);
        assert.equal(
          error.stderr,
          "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production\n",
        );
        return true;
      },
    );
    assert.equal(
      result.inputs.some((path) =>
        /node_modules\/(?:tsx|typescript|esbuild)\//u.test(path),
      ),
      false,
    );
    assert.equal(
      result.externalImports.every((specifier) => {
        const bare = specifier.replace(/^node:/u, "");
        return (
          builtinSet.has(bare) ||
          specifier === "@aws-sdk/client-secrets-manager" ||
          specifier === "pg" ||
          specifier.startsWith("pg/") ||
          specifier.startsWith("@opentelemetry/")
        );
      }),
      true,
    );
    assert.equal(result.externalImports.includes("pg"), true);
    assert.equal(
      result.externalImports.includes("@aws-sdk/client-secrets-manager"),
      true,
    );
    assert.deepEqual(result.bundledOidcPackages, [
      "jose",
      "oauth4webapi",
      "openid-client",
    ]);
    assert.deepEqual(
      result.externalImports.filter((specifier) =>
        ["jose", "oauth4webapi", "openid-client"].includes(specifier),
      ),
      [],
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("buildApiRuntime keeps test-only fixtures out of the runtime bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-api-runtime-"));

  try {
    const result = await buildApiRuntime({ outdir: directory });

    assert.deepEqual(findBundledDevelopmentOnlyModules(result.inputs), []);
    assert.equal(
      result.inputs.includes("apps/api-node/src/fixtures.ts"),
      false,
    );
    assert.equal(
      result.externalImports.includes("apps/api-node/src/fixtures.ts"),
      false,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the runtime bundle reaches the fixtures only through a dynamic import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-api-runtime-"));

  try {
    const result = await buildApiRuntime({ outdir: directory });
    const apiBundle = await readFile(join(directory, "api.mjs"), "utf8");

    assert.match(apiBundle, /import\("\.\/fixtures\.js"\)/u);
    assert.doesNotMatch(apiBundle, /from\s*"\.\/fixtures\.js"/u);
    assert.equal(result.externalImports.includes("./fixtures.js"), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("buildApiRuntime externalizes a dynamically imported development-only module", async () => {
  await withRuntimeSourceTree(
    {
      "apps/api-node/src/index.ts": entrySource,
      "apps/api-node/src/runtime-composition.ts": [
        "export const load = async () =>",
        '  (await import("./fixtures.js")).createFixturePersistence;',
        "",
      ].join("\n"),
      "apps/api-node/src/fixtures.ts": fixtureSource,
    },
    async ({ build, root }) => {
      const result = await build();
      const apiBundle = await readFile(join(root, "out", "api.mjs"), "utf8");

      assert.equal(
        result.inputs.includes("apps/api-node/src/fixtures.ts"),
        false,
      );
      assert.deepEqual(result.externalImports, []);
      assert.match(apiBundle, /import\("\.\/fixtures\.js"\)/u);
    },
  );
});

test("buildApiRuntime rejects a statically imported development-only module", async () => {
  await withRuntimeSourceTree(
    {
      "apps/api-node/src/index.ts": entrySource,
      "apps/api-node/src/runtime-composition.ts": [
        'import { createFixturePersistence } from "./fixtures.js";',
        "",
        "export const load = () => Promise.resolve(createFixturePersistence);",
        "",
      ].join("\n"),
      "apps/api-node/src/fixtures.ts": fixtureSource,
    },
    async ({ build }) => {
      await assert.rejects(
        build(),
        /Development-only module must stay behind a dynamic import: apps\/api-node\/src\/fixtures\.ts \(import-statement\)/u,
      );
    },
  );
});

test("buildApiRuntime rejects a bundled OIDC testing fixture", async () => {
  await withRuntimeSourceTree(
    {
      "apps/api-node/src/index.ts": [
        'import { startOidcFixture } from "./testing/oidc-fixture.js";',
        "",
        "startOidcFixture();",
        "",
      ].join("\n"),
      "apps/api-node/src/testing/oidc-fixture.ts":
        "export const startOidcFixture = () => undefined;\n",
    },
    async ({ build }) => {
      await assert.rejects(
        build(),
        /Development-only module bundled into the API runtime: apps\/api-node\/src\/testing\/oidc-fixture\.ts/u,
      );
    },
  );
});

test("buildApiRuntime bundles an unrelated ./fixtures.js instead of externalizing it", async () => {
  await withRuntimeSourceTree(
    {
      "apps/api-node/src/index.ts": [
        'import { helper } from "../../../packages/backend/src/helper.js";',
        "",
        "helper();",
        "",
      ].join("\n"),
      "packages/backend/src/helper.ts": [
        'import { seed } from "./fixtures.js";',
        "",
        "export const helper = () => seed();",
        "",
      ].join("\n"),
      "packages/backend/src/fixtures.ts": "export const seed = () => 1;\n",
    },
    async ({ build }) => {
      const result = await build();

      assert.equal(
        result.inputs.includes("packages/backend/src/fixtures.ts"),
        true,
      );
      assert.deepEqual(result.externalImports, []);
    },
  );
});

test("findStaticDevelopmentOnlyExternals separates dynamic from static development-only externals", () => {
  assert.deepEqual(
    findStaticDevelopmentOnlyExternals({
      outputs: {
        "api.mjs": {
          imports: [
            { external: true, kind: "dynamic-import", path: "./fixtures.js" },
            { external: true, kind: "dynamic-import", path: "pg" },
          ],
        },
      },
    }),
    [],
  );
  assert.deepEqual(
    findStaticDevelopmentOnlyExternals({
      outputs: {
        "api.mjs": {
          imports: [
            { external: true, kind: "import-statement", path: "./fixtures.js" },
          ],
        },
      },
    }),
    ["./fixtures.js (import-statement)"],
  );
});

test("assertDevelopmentOnlyExternalsAreDynamic rejects a statically externalized fixture", () => {
  assert.deepEqual(
    assertDevelopmentOnlyExternalsAreDynamic({
      outputs: {
        "api.mjs": {
          imports: [
            { external: true, kind: "dynamic-import", path: "./fixtures.js" },
          ],
        },
      },
    }),
    [],
  );
  assert.throws(
    () =>
      assertDevelopmentOnlyExternalsAreDynamic({
        outputs: {
          "api.mjs": {
            imports: [
              {
                external: true,
                kind: "import-statement",
                path: "./fixtures.js",
              },
            ],
          },
        },
      }),
    /Development-only module must stay behind a dynamic import: \.\/fixtures\.js \(import-statement\)/u,
  );
});

test("findBundledDevelopmentOnlyModules reports a bundled fixture module", () => {
  assert.deepEqual(
    findBundledDevelopmentOnlyModules([
      "apps/api-node/src/index.ts",
      "apps/api-node/src/fixtures.ts",
    ]),
    ["apps/api-node/src/fixtures.ts"],
  );
});

test("assertDevelopmentOnlyModulesExcluded rejects a bundled fixture module", () => {
  assert.deepEqual(
    assertDevelopmentOnlyModulesExcluded(["apps/api-node/src/index.ts"]),
    [],
  );
  assert.throws(
    () =>
      assertDevelopmentOnlyModulesExcluded([
        "apps/api-node/src/index.ts",
        "apps/api-node/src/fixtures.ts",
      ]),
    /Development-only module bundled into the API runtime: apps\/api-node\/src\/fixtures\.ts/u,
  );
});

test("assertAllowedRuntimeExternals rejects unexpected package imports", () => {
  assert.throws(
    () =>
      assertAllowedRuntimeExternals({
        outputs: {
          "api.mjs": {
            imports: [{ external: true, path: "hono" }],
          },
        },
      }),
    /Unexpected runtime external: hono/u,
  );
});

test("assertAllowedCreateRequireExternals rejects an unexpected literal package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-runtime-source-"));
  const source = join(directory, "unexpected.ts");

  try {
    await writeFile(
      source,
      [
        'import { createRequire as makeRequire } from "node:module";',
        "const loadPackage = makeRequire(import.meta.url);",
        'loadPackage("hono");',
      ].join("\n"),
    );

    await assert.rejects(
      assertAllowedCreateRequireExternals([source]),
      /Unexpected runtime external: hono/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("assertAllowedCreateRequireExternals rejects namespace and default loader imports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-runtime-source-"));

  try {
    for (const [name, sourceText] of [
      [
        "namespace",
        [
          'import * as moduleApi from "node:module";',
          "const makeRequire = moduleApi.createRequire;",
          "const loadPackage = makeRequire(import.meta.url);",
          'loadPackage("hono");',
        ].join("\n"),
      ],
      [
        "default",
        [
          'import moduleApi from "node:module";',
          "const makeRequire = moduleApi.createRequire;",
          "const loadPackage = makeRequire(import.meta.url);",
          'loadPackage("hono");',
        ].join("\n"),
      ],
    ]) {
      await t.test(name, async () => {
        const source = join(directory, `${name}-import.ts`);
        await writeFile(source, sourceText!);
        await assert.rejects(
          assertAllowedCreateRequireExternals([source]),
          /Unsupported node:module (?:namespace|default) import/u,
        );
      });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("assertAllowedCreateRequireExternals rejects a loader alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-runtime-source-"));
  const source = join(directory, "loader-alias.ts");

  try {
    await writeFile(
      source,
      [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        "const load = require;",
        'load("hono");',
      ].join("\n"),
    );

    await assert.rejects(
      assertAllowedCreateRequireExternals([source]),
      /Unsupported createRequire loader reference/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("assertAllowedCreateRequireExternals rejects a non-literal package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-runtime-source-"));
  const source = join(directory, "non-literal.ts");

  try {
    await writeFile(
      source,
      [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        'const packageName = "hono";',
        "require(packageName);",
      ].join("\n"),
    );

    await assert.rejects(
      assertAllowedCreateRequireExternals([source]),
      /Non-literal runtime external/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("assertAllowedCreateRequireExternals rejects inline and assignment forms", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-runtime-source-"));

  try {
    for (const [name, sourceText] of [
      [
        "inline",
        [
          'import { createRequire } from "node:module";',
          'createRequire(import.meta.url)("hono");',
        ].join("\n"),
      ],
      [
        "assignment",
        [
          'import { createRequire } from "node:module";',
          "let require;",
          "require = createRequire(import.meta.url);",
          'require("hono");',
        ].join("\n"),
      ],
    ]) {
      await t.test(name, async () => {
        const source = join(directory, `${name}.ts`);
        await writeFile(source, sourceText!);
        await assert.rejects(
          assertAllowedCreateRequireExternals([source]),
          /Unsupported createRequire usage/u,
        );
      });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
