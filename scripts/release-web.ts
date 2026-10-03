import console from "node:console";
import { access } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  createAsyncCommandRunner,
  type CommandRunner,
} from "./docker/compose-project.ts";
import {
  assertReleaseGitStateUnchanged,
  readReleaseGitState,
  requireAwsCli,
} from "./release-git.ts";

// pnpm release:web: HEAD から web を build し、apps/web/build/client を web bucket に置く。hash 付きの
// 資産を先に、index.html をその後に置くので、どの時点で止まっても配信中の index.html が参照する
// 資産は揃っている。

const defaultBuildDirectory = fileURLToPath(
  new URL("../apps/web/build/client", import.meta.url),
);

// S3 の bucket 名の規則（小文字・数字・ドット・ハイフン、3〜63 文字）。s3:// や path を混ぜた
// 値を弾き、aws s3 の宛先を bucket の直下に限る。
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const distributionIdPattern = /^[A-Z0-9]{1,128}$/u;

// 資産は内容の hash を名前に持ち（外部化した inline script も assets/inline-<sha256>.js）、
// 同じ名前で中身が変わらないので 1 年キャッシュしてよい。
const assetCacheControl = "public,max-age=31536000,immutable";
// CloudFront の SPA 用 cache policy は default_ttl = 0 なので、no-cache の index.html は毎回オリジンに
// 確かめられ、invalidation なしで新しい版に切り替わる見込み（実 AWS では未検証）。
const entryCacheControl = "no-cache";

const parseReleaseWebArguments = (argv: readonly string[]) => {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      "allow-dirty": { default: false, type: "boolean" },
      bucket: { type: "string" },
      "distribution-id": { type: "string" },
    },
    strict: true,
  });
  const bucket = values.bucket;
  if (bucket === undefined || !bucketPattern.test(bucket)) {
    throw new Error(
      "Usage: pnpm release:web --bucket <dev output web_bucket_name> [--distribution-id <dev output distribution_id>] [--allow-dirty]",
    );
  }
  const distributionId = values["distribution-id"];
  if (
    distributionId !== undefined &&
    !distributionIdPattern.test(distributionId)
  ) {
    throw new Error(
      "--distribution-id must be the dev output distribution_id.",
    );
  }
  return { allowDirty: values["allow-dirty"], bucket, distributionId };
};

export const runReleaseWeb = async ({
  argv,
  buildDirectory = defaultBuildDirectory,
  commandRunner = createAsyncCommandRunner(),
  log = (message: string) => {
    console.error(message);
  },
  now = () => new Date(),
}: {
  argv: readonly string[];
  buildDirectory?: string;
  commandRunner?: Pick<CommandRunner, "run">;
  log?: (message: string) => void;
  now?: () => Date;
}) => {
  const { allowDirty, bucket, distributionId } = parseReleaseWebArguments(argv);

  const run = commandRunner.run.bind(commandRunner);
  await requireAwsCli(run);
  const gitState = await readReleaseGitState({
    allowDirty,
    commandRunner,
    warn: log,
  });
  const { commit, dirty } = gitState;

  // apps/web/build は gitignore されているので、clean な作業ツリーでも既存の build が HEAD から
  // 作られたとは限らない。ここで build し直し、置くファイルを常に HEAD（と dirty の差分）から作る。
  // web の build script は inline script の外部化（CSP のため）まで含む。pull の後に install を
  // 忘れると古い依存のまま build が通り、release.json だけが HEAD の commit を名乗るので、先に
  // lockfile どおりの依存へ揃える。
  await run("pnpm", ["install", "--frozen-lockfile"]);
  await run("pnpm", ["--filter", "@starter/web", "build"]);
  await assertReleaseGitStateUnchanged({
    before: gitState,
    commandRunner,
    consequence: "Nothing was uploaded.",
  });

  const indexPath = join(buildDirectory, "index.html");
  try {
    await access(indexPath);
  } catch {
    throw new Error(`The web build did not produce ${indexPath}.`);
  }

  // --delete は付けない。古い index.html を開いたままのクライアントが参照する旧資産を消さないため。
  await run("aws", [
    "s3",
    "sync",
    `${buildDirectory}/`,
    `s3://${bucket}/`,
    "--exclude",
    "index.html",
    "--cache-control",
    assetCacheControl,
    "--no-cli-pager",
  ]);
  log(`Uploaded hashed assets to s3://${bucket}/`);

  await run("aws", [
    "s3",
    "cp",
    indexPath,
    `s3://${bucket}/index.html`,
    "--cache-control",
    entryCacheControl,
    "--content-type",
    "text/html; charset=utf-8",
    "--no-cli-pager",
  ]);
  log(`Uploaded index.html for ${commit}${dirty ? " (dirty)" : ""}`);

  // 配信中の commit を外から確かめるための印。秘匿情報は入れない。資料 12 §6.4 は index.html の前に
  // 置く順だが、index.html の upload が失敗したときに release.json だけが新しい commit を指さないよう、
  // index.html を置けた後にする。
  const releaseJson = `${JSON.stringify({
    commit,
    dirty,
    releasedAt: now().toISOString(),
  })}\n`;
  await run(
    "aws",
    [
      "s3",
      "cp",
      "-",
      `s3://${bucket}/release.json`,
      "--cache-control",
      entryCacheControl,
      "--content-type",
      "application/json",
      "--no-cli-pager",
    ],
    { stdin: releaseJson },
  );

  if (distributionId !== undefined) {
    await run("aws", [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      distributionId,
      "--paths",
      "/index.html",
      "--no-cli-pager",
    ]);
    log(`Requested a CloudFront invalidation of /index.html`);
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runReleaseWeb({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
