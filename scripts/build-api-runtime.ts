import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type PluginBuild } from "esbuild";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// 検査が読むのは outputs の imports だけ。esbuild の Metafile をそのまま要求すると、
// bytes や exports まで揃えない限りこの検査を呼べなくなる。
type RuntimeMetafile = {
  outputs: Record<
    string,
    { imports: { external?: boolean; kind?: string; path: string }[] }
  >;
};

// テスト専用モジュールはランタイムバンドルに入れない。本番イメージでは解決できないため、
// NODE_ENV=test で起動しても固定フィクスチャではなく起動失敗になる。
// dynamicImportSpecifier を持つものだけが、その指定子の動的 import に限り外部化される。
const developmentOnlyRuntimeModules = [
  {
    input: "apps/api-node/src/fixtures.ts",
    dynamicImportSpecifier: "./fixtures.js",
  },
  { input: "apps/api-node/src/testing/oidc-fixture.ts" },
];

// esbuild の external は生の指定子テキストに一致するだけで、解決先を見ない。
// 開発専用モジュールをここに並べると静的 import も無検査で外部化されるため、
// 外部化はプラグイン側で解決先とインポート種別を確かめてから行う。
const external = [
  "pg",
  "pg/*",
  "@opentelemetry/*",
  "@aws-sdk/client-secrets-manager",
];
const builtinSet = new Set(
  builtinModules.map((specifier) => specifier.replace(/^node:/u, "")),
);

const defaultEntryPoints = {
  api: "apps/api-node/src/index.ts",
  migrate: "apps/api-node/src/migrate.ts",
};
const defaultOutdir = fileURLToPath(
  new URL("../apps/api-node/dist/runtime", import.meta.url),
);
const oidcRuntimePackageNames = ["jose", "oauth4webapi", "openid-client"];

const packageInputPattern = (packageName: string) =>
  new RegExp(
    `(?:^|/)node_modules/(?:\\.pnpm/[^/]+/node_modules/)?${packageName}(?:/|$)`,
    "u",
  );

export const findBundledOidcPackages = (inputs: readonly string[]) =>
  oidcRuntimePackageNames.filter((packageName) =>
    inputs.some((input) => packageInputPattern(packageName).test(input)),
  );

const normalizeInput = (input: string) => input.replaceAll("\\", "/");

const externalizableDevelopmentOnlyModules =
  developmentOnlyRuntimeModules.filter(
    (module) => module.dynamicImportSpecifier !== undefined,
  );

const isDevelopmentOnlyExternal = (specifier: string) =>
  externalizableDevelopmentOnlyModules.some(
    (module) => module.dynamicImportSpecifier === specifier,
  );

export const findBundledDevelopmentOnlyModules = (
  inputs: readonly string[],
) => {
  const bundled = new Set(inputs.map(normalizeInput));
  return developmentOnlyRuntimeModules
    .filter(({ input }) => bundled.has(input))
    .map(({ input }) => input);
};

export const assertDevelopmentOnlyModulesExcluded = (
  inputs: readonly string[],
) => {
  const bundled = findBundledDevelopmentOnlyModules(inputs);
  if (bundled.length > 0) {
    throw new Error(
      `Development-only module bundled into the API runtime: ${bundled.join(", ")}`,
    );
  }
  return bundled;
};

export const findStaticDevelopmentOnlyExternals = (
  metafile: RuntimeMetafile,
) => {
  const violations = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue;
      if (!isDevelopmentOnlyExternal(imported.path)) continue;
      if (imported.kind === "dynamic-import") continue;
      violations.add(`${imported.path} (${imported.kind})`);
    }
  }
  return [...violations].sort();
};

// external 配列に開発専用の指定子が戻された場合も静的 import を外部化させないための保険。
export const assertDevelopmentOnlyExternalsAreDynamic = (
  metafile: RuntimeMetafile,
) => {
  const violations = findStaticDevelopmentOnlyExternals(metafile);
  if (violations.length > 0) {
    throw new Error(
      `Development-only module must stay behind a dynamic import: ${violations.join(", ")}`,
    );
  }
  return violations;
};

const sourceExtensionPattern = /\.(?:[cm]?[jt]sx?)$/u;
const stripSourceExtension = (path: string) =>
  path.replace(sourceExtensionPattern, "");

const developmentOnlyResolveFilter = new RegExp(
  `(?:^|/)(?:${externalizableDevelopmentOnlyModules
    .map(({ dynamicImportSpecifier }) =>
      basename(dynamicImportSpecifier).replaceAll(
        /[.*+?^${}()|[\]\\]/gu,
        "\\$&",
      ),
    )
    .join("|")})$`,
);

// 解決先の絶対パスを見てから外部化するので、他パッケージの同名 "./fixtures.js" は巻き込まない。
const developmentOnlyExternalsPlugin = (root: string) => ({
  name: "development-only-externals",
  setup(pluginBuild: PluginBuild) {
    if (externalizableDevelopmentOnlyModules.length === 0) return;
    pluginBuild.onResolve({ filter: developmentOnlyResolveFilter }, (args) => {
      if (args.namespace !== "" && args.namespace !== "file") return undefined;
      const resolveDir =
        args.resolveDir ||
        (args.importer === "" ? root : dirname(args.importer));
      const candidate = stripSourceExtension(
        normalizeInput(relative(root, resolve(resolveDir, args.path))),
      );
      const target = externalizableDevelopmentOnlyModules.find(
        (module) =>
          module.dynamicImportSpecifier === args.path &&
          stripSourceExtension(module.input) === candidate,
      );
      if (target === undefined) return undefined;
      if (args.kind === "dynamic-import") {
        return { external: true, path: args.path };
      }
      return {
        errors: [
          {
            text: `Development-only module must stay behind a dynamic import: ${target.input} (${args.kind})`,
          },
        ],
      };
    });
  },
});

const assertAllowedRuntimeExternal = (specifier: string) => {
  const bare = specifier.replace(/^node:/u, "");
  const allowed =
    builtinSet.has(bare) ||
    specifier === "@aws-sdk/client-secrets-manager" ||
    specifier === "pg" ||
    specifier.startsWith("pg/") ||
    specifier.startsWith("@opentelemetry/");
  if (!allowed) {
    throw new Error(`Unexpected runtime external: ${specifier}`);
  }
};

export const assertAllowedRuntimeExternals = (metafile: RuntimeMetafile) => {
  const specifiers = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue;
      // 意図的に未解決のまま残すテスト専用モジュールは、実行環境に用意する依存ではない。
      if (isDevelopmentOnlyExternal(imported.path)) continue;
      specifiers.add(imported.path);
      assertAllowedRuntimeExternal(imported.path);
    }
  }
  return [...specifiers].sort();
};

const visitNodes = (root: ts.Node, visit: (node: ts.Node) => void) => {
  const walk = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
};

export const assertAllowedCreateRequireExternals = async (
  inputs: readonly string[],
  root = repositoryRoot,
) => {
  const specifiers = new Set<string>();

  for (const input of inputs) {
    const sourcePath = resolve(root, input);
    const sourceFile = ts.createSourceFile(
      sourcePath,
      await readFile(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const createRequireNames = new Set<string>();
    const loaderNames = new Set<string>();
    const supportedFactoryCalls = new Set<ts.Node>();

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        (statement.moduleSpecifier.text !== "node:module" &&
          statement.moduleSpecifier.text !== "module")
      ) {
        continue;
      }
      const importClause = statement.importClause;
      if (importClause?.name !== undefined) {
        throw new Error(`Unsupported node:module default import in ${input}`);
      }
      const bindings = importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        throw new Error(`Unsupported node:module namespace import in ${input}`);
      }
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "createRequire") {
          createRequireNames.add(element.name.text);
        }
      }
    }

    visitNodes(sourceFile, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        createRequireNames.has(node.initializer.expression.text)
      ) {
        loaderNames.add(node.name.text);
        supportedFactoryCalls.add(node.initializer);
      }
    });

    visitNodes(sourceFile, (node) => {
      if (!ts.isIdentifier(node)) return;

      if (createRequireNames.has(node.text)) {
        if (ts.isImportSpecifier(node.parent)) return;
        if (
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node &&
          supportedFactoryCalls.has(node.parent)
        ) {
          return;
        }
        throw new Error(`Unsupported createRequire usage in ${input}`);
      }

      if (!loaderNames.has(node.text)) return;
      if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
        return;
      }
      if (
        !ts.isCallExpression(node.parent) ||
        node.parent.expression !== node
      ) {
        throw new Error(
          `Unsupported createRequire loader reference in ${input}`,
        );
      }

      const [argument] = node.parent.arguments;
      if (
        node.parent.arguments.length !== 1 ||
        argument === undefined ||
        !ts.isStringLiteralLike(argument)
      ) {
        throw new Error(`Non-literal runtime external in ${input}`);
      }
      assertAllowedRuntimeExternal(argument.text);
      specifiers.add(argument.text);
    });
  }

  return [...specifiers].sort();
};

export const buildApiRuntime = async ({
  entryPoints = defaultEntryPoints,
  outdir = defaultOutdir,
  root: requestedRoot = repositoryRoot,
}: {
  entryPoints?: Record<string, string>;
  outdir?: string;
  root?: string;
} = {}) => {
  // esbuild は importer/resolveDir をシンボリックリンク解決後のパスで渡すため、
  // 解決先の突き合わせが成立するように基準ディレクトリも実体パスへそろえる。
  const root = realpathSync(requestedRoot);
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints,
    external,
    format: "esm",
    logLevel: "info",
    metafile: true,
    outdir,
    outExtension: { ".js": ".mjs" },
    platform: "node",
    plugins: [developmentOnlyExternalsPlugin(root)],
    sourcemap: false,
    splitting: false,
    target: "node24",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assertDevelopmentOnlyModulesExcluded(inputs);
  assertDevelopmentOnlyExternalsAreDynamic(result.metafile);
  const externalImports = [
    ...new Set([
      ...assertAllowedRuntimeExternals(result.metafile),
      ...(await assertAllowedCreateRequireExternals(inputs, root)),
    ]),
  ].sort();
  const bundledOidcPackages = findBundledOidcPackages(inputs);
  return {
    bundledOidcPackages,
    externalImports,
    inputs,
    outputs: Object.keys(result.metafile.outputs).map((path) =>
      resolve(root, path),
    ),
  };
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildApiRuntime();
}
