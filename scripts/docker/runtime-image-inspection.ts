import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  runtimeSnapshotSchema,
  type PackageManifest,
  type RuntimeSnapshot,
} from "../schemas.ts";

const expectedAppPaths = [
  "api.mjs",
  "certs",
  "migrate.mjs",
  "migrations",
  "node_modules",
  "package.json",
];
const expectedManifestKeys = ["dependencies", "name", "private", "type"];
const expectedRuntimeDependencies = [
  "@aws-sdk/client-secrets-manager",
  "@opentelemetry/api",
  "@opentelemetry/core",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-pg",
  "@opentelemetry/sdk-node",
  "pg",
];

// 依存はすべて注入で受ける。型を `typeof import(...)` で書くのは、引数名がモジュール直下の
// import を隠していても正しい形を指せるようにするため。
type FsPromises = typeof import("node:fs/promises");

type RuntimeImageDependencies = {
  appRoot: string;
  chmod: FsPromises["chmod"];
  createHash: typeof import("node:crypto").createHash;
  createRequire: typeof import("node:module").createRequire;
  mkdtemp: FsPromises["mkdtemp"];
  open: FsPromises["open"];
  path: typeof import("node:path");
  readdir: FsPromises["readdir"];
  readFile: FsPromises["readFile"];
  realpath: FsPromises["realpath"];
  rename: FsPromises["rename"];
  rm: FsPromises["rm"];
  stat: FsPromises["stat"];
  tmpdir: typeof import("node:os").tmpdir;
  writeFile: FsPromises["writeFile"];
};

export const inspectRuntimeImageWithDependencies = async ({
  appRoot,
  chmod,
  createHash,
  createRequire,
  mkdtemp,
  open,
  path,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  tmpdir,
  writeFile,
}: RuntimeImageDependencies) => {
  const nodeModulesRoot = path.join(appRoot, "node_modules");
  const realNodeModulesRoot = await realpath(nodeModulesRoot);
  const classify = (entry: { isDirectory(): boolean; isFile(): boolean }) =>
    entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "symlink";
  // package.json は外部入力。形をここで 1 度だけ確かめ、以降は推論型で扱う。
  // schemas.ts の zod スキーマは使えない。この関数は toString() でコンテナに持ち込まれ、
  // そこには zod も schemas.ts もないため、検査は組み込みだけで行う。
  const readJson = async (filePath: string): Promise<PackageManifest> => {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${filePath} is not a JSON object`);
    }
    return parsed as PackageManifest;
  };
  const appEntries = (await readdir(appRoot, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
  const repositoryEntries: { path: string; type: string }[] = [];

  const walkRepository = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entryPath === nodeModulesRoot) continue;
      const type = classify(entry);
      repositoryEntries.push({ path: entryPath, type });
      if (entry.isDirectory()) await walkRepository(entryPath);
    }
  };
  await walkRepository(appRoot);
  repositoryEntries.sort((left, right) => left.path.localeCompare(right.path));

  const rdsCaPath = path.join(appRoot, "certs", "global-bundle.pem");
  const rdsCaDirectory = path.dirname(rdsCaPath);
  const [rdsCaBytes, rdsCaFileStat, rdsCaDirectoryStat] = await Promise.all([
    readFile(rdsCaPath),
    stat(rdsCaPath),
    stat(rdsCaDirectory),
  ]);
  const captureMutationProbe = async (
    probe: () => Promise<void>,
    successCode: string,
  ): Promise<unknown> => {
    try {
      await probe();
      return successCode;
    } catch (error) {
      return (error as { code?: unknown } | undefined)?.code;
    }
  };
  const appendErrorCode = await captureMutationProbe(async () => {
    const handle = await open(rdsCaPath, "a");
    await handle.close();
  }, "OPENED");
  const chmodErrorCode = await captureMutationProbe(
    () => chmod(rdsCaPath, 0o600),
    "CHMODDED",
  );
  let replacementDirectory;
  let replaceErrorCode;
  try {
    replacementDirectory = await mkdtemp(
      path.join(tmpdir(), "hono-starter-rds-ca-replacement-"),
    );
    const replacementPath = path.join(replacementDirectory, "replacement.pem");
    await writeFile(replacementPath, rdsCaBytes, { mode: 0o600 });
    replaceErrorCode = await captureMutationProbe(
      () => rename(replacementPath, rdsCaPath),
      "RENAMED",
    );
  } catch (error) {
    replaceErrorCode = (error as { code?: unknown } | undefined)?.code;
  } finally {
    if (replacementDirectory !== undefined) {
      await rm(replacementDirectory, { force: true, recursive: true });
    }
  }
  const unlinkErrorCode = await captureMutationProbe(
    () => rm(rdsCaPath),
    "UNLINKED",
  );
  const rdsCa = {
    appendErrorCode,
    chmodErrorCode,
    directory: {
      gid: rdsCaDirectoryStat.gid,
      mode: rdsCaDirectoryStat.mode & 0o777,
      path: rdsCaDirectory,
      uid: rdsCaDirectoryStat.uid,
    },
    gid: rdsCaFileStat.gid,
    inspector: {
      gid: process.getgid?.(),
      uid: process.getuid?.(),
    },
    mode: rdsCaFileStat.mode & 0o777,
    path: rdsCaPath,
    replaceErrorCode,
    sha256: createHash("sha256").update(rdsCaBytes).digest("hex"),
    uid: rdsCaFileStat.uid,
    unlinkErrorCode,
  };

  const installedPackagesByRealPath = new Map<
    string,
    { name: string; path: string }
  >();
  const scannedNodeModules = new Set<string>();
  const scanPackage = async (packageDirectory: string) => {
    let realDirectory: string;
    let manifest: PackageManifest;
    try {
      realDirectory = await realpath(packageDirectory);
      manifest = await readJson(path.join(packageDirectory, "package.json"));
    } catch {
      return;
    }
    if (typeof manifest.name !== "string") return;
    if (!installedPackagesByRealPath.has(realDirectory)) {
      installedPackagesByRealPath.set(realDirectory, {
        name: manifest.name,
        path: packageDirectory,
      });
    }
    await scanNodeModules(path.join(packageDirectory, "node_modules"));
  };
  const scanScope = async (scopeDirectory: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(scopeDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await scanPackage(path.join(scopeDirectory, entry.name));
      }
    }
  };
  const scanPnpmStore = async (pnpmDirectory: string) => {
    await scanNodeModules(path.join(pnpmDirectory, "node_modules"));
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(pnpmDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await scanNodeModules(
          path.join(pnpmDirectory, entry.name, "node_modules"),
        );
      }
    }
  };
  const scanNodeModules = async (nodeModulesDirectory: string) => {
    let realDirectory: string;
    let entries: import("node:fs").Dirent[];
    try {
      realDirectory = await realpath(nodeModulesDirectory);
      if (scannedNodeModules.has(realDirectory)) return;
      scannedNodeModules.add(realDirectory);
      entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".pnpm") {
        await scanPnpmStore(path.join(nodeModulesDirectory, entry.name));
      } else if (entry.name.startsWith("@")) {
        await scanScope(path.join(nodeModulesDirectory, entry.name));
      } else if (
        !entry.name.startsWith(".") &&
        (entry.isDirectory() || entry.isSymbolicLink())
      ) {
        await scanPackage(path.join(nodeModulesDirectory, entry.name));
      }
    }
  };
  await scanNodeModules(nodeModulesRoot);

  const packageManifest = await readJson(path.join(appRoot, "package.json"));
  const dependencyProblems = [];
  const reachablePackageRealPaths = new Set<string>();
  const pendingPackages = [{ directory: appRoot, manifest: packageManifest }];
  const isInsideNodeModules = (candidate: string) => {
    const relativePath = path.relative(realNodeModulesRoot, candidate);
    return (
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    );
  };
  const findPackageRoot = async (
    resolvedPath: string,
    dependencyName: string,
  ) => {
    if (!path.isAbsolute(resolvedPath)) return undefined;
    let directory = path.dirname(resolvedPath);
    while (true) {
      try {
        const manifest = await readJson(path.join(directory, "package.json"));
        if (manifest.name === dependencyName) {
          const realDirectory = await realpath(directory);
          if (!isInsideNodeModules(realDirectory)) return undefined;
          return { directory: realDirectory, manifest, realDirectory };
        }
      } catch {
        // この上位ディレクトリは目的のパッケージルートではない。
      }
      const parentDirectory = path.dirname(directory);
      if (parentDirectory === directory) return undefined;
      directory = parentDirectory;
    }
  };
  const resolveInstalledDependency = async (
    directory: string,
    dependencyName: string,
  ) => {
    const requireFromPackage = createRequire(
      path.join(directory, "package.json"),
    );
    for (const specifier of [
      `${dependencyName}/package.json`,
      dependencyName,
    ]) {
      try {
        const resolvedPath = requireFromPackage.resolve(specifier);
        const installedDependency = await findPackageRoot(
          resolvedPath,
          dependencyName,
        );
        if (installedDependency !== undefined) return installedDependency;
      } catch {
        // 規約どおりの次のパッケージ指定子を試す。
      }
    }
    return undefined;
  };

  while (pendingPackages.length > 0) {
    const current = pendingPackages.shift();
    if (current === undefined) break;
    const requiredDependencies = new Set(
      Object.keys(current.manifest.dependencies ?? {}),
    );
    const optionalDependencies = new Set(
      Object.keys(current.manifest.optionalDependencies ?? {}),
    );
    for (const dependencyName of optionalDependencies) {
      requiredDependencies.delete(dependencyName);
    }
    const peerDependencyNames = new Set([
      ...Object.keys(current.manifest.peerDependencies ?? {}),
      ...Object.entries(current.manifest.peerDependenciesMeta ?? {})
        .filter(
          ([, metadata]) =>
            (metadata as { optional?: unknown } | undefined)?.optional === true,
        )
        .map(([dependencyName]) => dependencyName),
    ]);
    for (const dependencyName of peerDependencyNames) {
      if (
        (
          current.manifest.peerDependenciesMeta as
            Record<string, { optional?: unknown }> | undefined
        )?.[dependencyName]?.optional === true
      ) {
        optionalDependencies.add(dependencyName);
      } else {
        requiredDependencies.add(dependencyName);
      }
    }
    for (const dependencyName of new Set([
      ...requiredDependencies,
      ...optionalDependencies,
    ])) {
      const dependency = await resolveInstalledDependency(
        current.directory,
        dependencyName,
      );
      if (dependency === undefined) {
        if (requiredDependencies.has(dependencyName)) {
          dependencyProblems.push(
            `missing dependency ${dependencyName} from ${current.directory}`,
          );
        }
        continue;
      }
      if (!reachablePackageRealPaths.has(dependency.realDirectory)) {
        reachablePackageRealPaths.add(dependency.realDirectory);
        pendingPackages.push(dependency);
      }
    }
  }

  for (const [realDirectory, installedPackage] of installedPackagesByRealPath) {
    if (!reachablePackageRealPaths.has(realDirectory)) {
      dependencyProblems.push(`extraneous package ${installedPackage.path}`);
    }
  }

  return {
    appRoot,
    appEntries,
    dependencyProblems: dependencyProblems.sort(),
    installedPackages: [...installedPackagesByRealPath.values()].sort(
      (left, right) => left.path.localeCompare(right.path),
    ),
    packageManifest,
    rdsCa,
    repositoryEntries,
  };
};

export const inspectRuntimeImage = ({ appRoot = "/app" } = {}) =>
  inspectRuntimeImageWithDependencies({
    appRoot,
    chmod,
    createHash,
    createRequire,
    mkdtemp,
    open,
    path,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    tmpdir,
    writeFile,
  });

// コンテナ側で `node --input-type=module --eval` する文字列。
// `inspectRuntimeImageWithDependencies` は toString() で持ち込まれるため、関数本体が
// 参照してよいのは引数と、このテンプレートが import する Node 組み込みだけ。
// モジュール直下の値（schemas.ts の zod スキーマを含む）を閉包で使うと、コンテナには
// 存在せず ReferenceError になる。ホスト内で同じ関数を直接呼ぶテストでは検出できない。
export const createRuntimeSnapshotScript = ({ appRoot = "/app" } = {}) =>
  `
import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const inspectRuntimeImageWithDependencies = ${inspectRuntimeImageWithDependencies.toString()};
const snapshot = await inspectRuntimeImageWithDependencies({
  appRoot: ${JSON.stringify(appRoot)},
  chmod,
  createHash,
  createRequire,
  mkdtemp,
  open,
  path,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  tmpdir,
  writeFile,
});
process.stdout.write(JSON.stringify(snapshot));
`.trim();

export const runtimeSnapshotScript = createRuntimeSnapshotScript();

export const parseRuntimeSnapshot = (output: string): unknown => {
  try {
    const snapshot: unknown = JSON.parse(output);
    if (snapshot === null || typeof snapshot !== "object") throw new Error();
    return snapshot;
  } catch {
    throw new Error(
      "Production image runtime inspection returned malformed JSON.",
    );
  }
};

const requireStringArray = (value: unknown, label: string): string[] => {
  if (
    !Array.isArray(value) ||
    (value as unknown[]).some((item) => typeof item !== "string")
  ) {
    throw new Error(
      `Production image runtime inspection returned invalid ${label}.`,
    );
  }
  return value as string[];
};

export const validateRuntimeSnapshot = (
  input: unknown,
  options?: {
    expectedRdsCaSha256?: string | undefined;
    expectedRuntimeGid?: number | undefined;
    expectedRuntimeUid?: number | undefined;
  },
) => {
  // 形が通れば推論型で読める。通らなければ下の既存チェックが従来どおりの文言で落とすので、
  // ここでは失敗を握らず、そのまま同じ変数に載せて先へ進める。
  const parsedSnapshot = runtimeSnapshotSchema.safeParse(input);
  const snapshot = (
    parsedSnapshot.success ? parsedSnapshot.data : input
  ) as RuntimeSnapshot;
  const expectedRdsCaSha256 = options?.expectedRdsCaSha256;
  const expectedRuntimeGid = options?.expectedRuntimeGid;
  const expectedRuntimeUid = options?.expectedRuntimeUid;
  if (!/^[0-9a-f]{64}$/u.test(expectedRdsCaSha256 ?? "")) {
    throw new Error(
      "Production image validation requires an expected RDS CA digest.",
    );
  }
  if (
    expectedRuntimeUid !== undefined &&
    (!Number.isSafeInteger(expectedRuntimeUid) || expectedRuntimeUid <= 0)
  ) {
    throw new Error(
      "Production image validation requires a non-root expected runtime UID.",
    );
  }
  if (
    expectedRuntimeGid !== undefined &&
    (!Number.isSafeInteger(expectedRuntimeGid) || expectedRuntimeGid < 0)
  ) {
    throw new Error(
      "Production image validation requires a valid expected runtime GID.",
    );
  }
  if (
    typeof snapshot.appRoot !== "string" ||
    !path.isAbsolute(snapshot.appRoot)
  ) {
    throw new Error(
      "Production image runtime inspection returned an invalid app root.",
    );
  }
  const appRoot = snapshot.appRoot;
  const appEntries = requireStringArray(snapshot.appEntries, "app entries");
  const missingPaths = expectedAppPaths.filter(
    (expectedPath) => !appEntries.includes(expectedPath),
  );
  const extraPaths = appEntries.filter(
    (actualPath) => !expectedAppPaths.includes(actualPath),
  );
  if (missingPaths.length > 0 || extraPaths.length > 0) {
    throw new Error(
      `Production image /app allow-list mismatch; missing: ${missingPaths.join(", ") || "none"}; extra: ${extraPaths.join(", ") || "none"}.`,
    );
  }

  if (
    !Array.isArray(snapshot.repositoryEntries) ||
    snapshot.repositoryEntries.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.path !== "string" ||
        !["directory", "file", "symlink"].includes(entry.type),
    )
  ) {
    throw new Error(
      "Production image runtime inspection returned invalid repository entries.",
    );
  }
  const forbiddenRepositoryPaths = snapshot.repositoryEntries
    .filter((entry) => {
      const relativePath = path.relative(appRoot, entry.path);
      const segments = relativePath.split("/");
      const filename = segments.at(-1) ?? "";
      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath) ||
        entry.path.startsWith(
          `${path.join(appRoot, "node_modules")}${path.sep}`,
        ) ||
        entry.type === "symlink" ||
        segments.some((segment) =>
          ["src", "test", "tests", "__tests__"].includes(segment),
        ) ||
        /\.(?:ts|tsx)$/u.test(filename) ||
        /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(filename)
      ) {
        return true;
      }
      if (
        entry.path.startsWith(`${path.join(appRoot, "migrations")}${path.sep}`)
      ) {
        return entry.type !== "directory" && !filename.endsWith(".sql");
      }
      return ![
        path.join(appRoot, "api.mjs"),
        path.join(appRoot, "certs"),
        path.join(appRoot, "certs", "global-bundle.pem"),
        path.join(appRoot, "migrate.mjs"),
        path.join(appRoot, "migrations"),
        path.join(appRoot, "package.json"),
      ].includes(entry.path);
    })
    .map((entry) => entry.path)
    .sort();
  if (forbiddenRepositoryPaths.length > 0) {
    throw new Error(
      `Production image contains forbidden repository paths: ${forbiddenRepositoryPaths.join(", ")}.`,
    );
  }
  const requiredRepositoryEntries = new Map([
    [path.join(appRoot, "certs"), "directory"],
    [path.join(appRoot, "certs", "global-bundle.pem"), "file"],
  ]);
  for (const [requiredPath, requiredType] of requiredRepositoryEntries) {
    if (
      !snapshot.repositoryEntries.some(
        (entry) => entry.path === requiredPath && entry.type === requiredType,
      )
    ) {
      throw new Error(
        `Production image is missing required runtime path ${requiredPath}.`,
      );
    }
  }

  if (
    snapshot.rdsCa === null ||
    typeof snapshot.rdsCa !== "object" ||
    snapshot.rdsCa.path !== path.join(appRoot, "certs", "global-bundle.pem") ||
    !/^[0-9a-f]{64}$/u.test(snapshot.rdsCa.sha256 ?? "") ||
    typeof snapshot.rdsCa.appendErrorCode !== "string" ||
    typeof snapshot.rdsCa.chmodErrorCode !== "string" ||
    snapshot.rdsCa.directory === null ||
    typeof snapshot.rdsCa.directory !== "object" ||
    snapshot.rdsCa.directory.path !== path.join(appRoot, "certs") ||
    !Number.isInteger(snapshot.rdsCa.directory.gid) ||
    !Number.isInteger(snapshot.rdsCa.directory.mode) ||
    snapshot.rdsCa.directory.mode < 0 ||
    snapshot.rdsCa.directory.mode > 0o777 ||
    !Number.isInteger(snapshot.rdsCa.directory.uid) ||
    !Number.isInteger(snapshot.rdsCa.gid) ||
    snapshot.rdsCa.inspector === null ||
    typeof snapshot.rdsCa.inspector !== "object" ||
    !Number.isInteger(snapshot.rdsCa.inspector.gid) ||
    !Number.isInteger(snapshot.rdsCa.inspector.uid) ||
    (snapshot.rdsCa.inspector.uid ?? 0) <= 0 ||
    !Number.isInteger(snapshot.rdsCa.mode) ||
    snapshot.rdsCa.mode < 0 ||
    snapshot.rdsCa.mode > 0o777 ||
    typeof snapshot.rdsCa.replaceErrorCode !== "string" ||
    !Number.isInteger(snapshot.rdsCa.uid) ||
    typeof snapshot.rdsCa.unlinkErrorCode !== "string"
  ) {
    throw new Error(
      "Production image runtime inspection returned invalid RDS CA metadata.",
    );
  }
  if (snapshot.rdsCa.sha256 !== expectedRdsCaSha256) {
    throw new Error("Production image RDS CA digest mismatch.");
  }
  if ((snapshot.rdsCa.mode & 0o222) !== 0) {
    throw new Error(
      "Production image RDS CA permissions allow runtime writes.",
    );
  }
  if (snapshot.rdsCa.uid !== 0 || snapshot.rdsCa.gid !== 0) {
    throw new Error("Production image RDS CA must be owned by root.");
  }
  if (
    snapshot.rdsCa.directory.uid !== 0 ||
    snapshot.rdsCa.directory.gid !== 0
  ) {
    throw new Error("Production image RDS CA directory must be owned by root.");
  }
  if ((snapshot.rdsCa.directory.mode & 0o022) !== 0) {
    throw new Error(
      "Production image RDS CA directory permissions allow runtime writes.",
    );
  }
  if (
    (expectedRuntimeUid !== undefined &&
      snapshot.rdsCa.inspector.uid !== expectedRuntimeUid) ||
    (expectedRuntimeGid !== undefined &&
      snapshot.rdsCa.inspector.gid !== expectedRuntimeGid)
  ) {
    throw new Error(
      "Production image RDS CA inspection did not run as the default runtime user.",
    );
  }
  for (const [label, errorCode] of [
    ["append", snapshot.rdsCa.appendErrorCode],
    ["chmod", snapshot.rdsCa.chmodErrorCode],
    ["replacement", snapshot.rdsCa.replaceErrorCode],
    ["unlink", snapshot.rdsCa.unlinkErrorCode],
  ]) {
    if (!["EACCES", "EPERM"].includes(errorCode ?? "")) {
      throw new Error(
        `Production image RDS CA ${label} probe did not deny runtime mutation.`,
      );
    }
  }

  const packageManifest = snapshot.packageManifest;
  if (
    packageManifest === null ||
    typeof packageManifest !== "object" ||
    Array.isArray(packageManifest)
  ) {
    throw new Error(
      "Production image runtime inspection returned an invalid package manifest.",
    );
  }
  const actualManifestKeys = Object.keys(packageManifest).sort();
  const missingManifestKeys = expectedManifestKeys.filter(
    (key) => !actualManifestKeys.includes(key),
  );
  const extraManifestKeys = actualManifestKeys.filter(
    (key) => !expectedManifestKeys.includes(key),
  );
  if (missingManifestKeys.length > 0 || extraManifestKeys.length > 0) {
    throw new Error(
      `Production image /app/package.json top-level keys mismatch; missing: ${missingManifestKeys.join(", ") || "none"}; extra: ${extraManifestKeys.join(", ") || "none"}.`,
    );
  }
  if (
    packageManifest.name !== "@starter/api-runtime-dependencies" ||
    packageManifest.private !== true ||
    packageManifest.type !== "module" ||
    packageManifest.dependencies === null ||
    typeof packageManifest.dependencies !== "object" ||
    Array.isArray(packageManifest.dependencies)
  ) {
    throw new Error(
      "Production image /app/package.json does not match the runtime manifest contract.",
    );
  }
  const actualRuntimeDependencies = Object.keys(
    packageManifest.dependencies,
  ).sort();
  const missingDependencies = expectedRuntimeDependencies.filter(
    (name) => !actualRuntimeDependencies.includes(name),
  );
  const extraDependencies = actualRuntimeDependencies.filter(
    (name) => !expectedRuntimeDependencies.includes(name),
  );
  if (missingDependencies.length > 0 || extraDependencies.length > 0) {
    throw new Error(
      `Production image runtime dependencies mismatch; missing: ${missingDependencies.join(", ") || "none"}; extra: ${extraDependencies.join(", ") || "none"}.`,
    );
  }
  const wrongDependencyValues = expectedRuntimeDependencies.filter(
    (name) =>
      (packageManifest.dependencies as Record<string, unknown>)[name] !==
      "catalog:",
  );
  if (wrongDependencyValues.length > 0) {
    throw new Error(
      `Production image /app/package.json dependency values mismatch: ${wrongDependencyValues.join(", ")}.`,
    );
  }

  if (
    !Array.isArray(snapshot.installedPackages) ||
    snapshot.installedPackages.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.name !== "string" ||
        typeof entry.path !== "string",
    )
  ) {
    throw new Error(
      "Production image runtime inspection returned invalid installed packages.",
    );
  }
  const forbiddenInstalledPackages = snapshot.installedPackages
    .filter(
      ({ name }) =>
        ["esbuild", "tsx", "typescript"].includes(name) ||
        name.startsWith("@esbuild/"),
    )
    .map(({ path: packagePath }) => packagePath)
    .sort();
  if (forbiddenInstalledPackages.length > 0) {
    throw new Error(
      `Production image contains forbidden installed packages: ${forbiddenInstalledPackages.join(", ")}.`,
    );
  }

  const dependencyProblems = requireStringArray(
    snapshot.dependencyProblems,
    "dependency problems",
  );
  if (dependencyProblems.length > 0) {
    const displayedProblems = dependencyProblems.slice(0, 5);
    throw new Error(
      `Production image runtime dependency tree reported ${dependencyProblems.length} problem${dependencyProblems.length === 1 ? "" : "s"}: ${displayedProblems.join(", ")}${dependencyProblems.length > displayedProblems.length ? ", additional problems omitted" : ""}.`,
    );
  }

  // 検証を通ったスナップショットを型付きで返す。呼び出し側が unknown を再解釈せずに済む。
  return snapshot;
};
