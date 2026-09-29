import console from "node:console";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  createAsyncCommandRunner,
  createInterruptionGuard,
  finishOwnedRun,
  type CommandRunner,
  type RunOptions,
  type SignalTarget,
} from "./docker/compose-project.ts";
import { devAuthRejectionStderr } from "./docker/production-image.ts";
import {
  assertReleaseGitStateUnchanged,
  formatUtcTimestamp,
  readReleaseGitState,
  requireAwsCli,
} from "./release-git.ts";
import { ecrDescribeImagesSchema } from "./schemas.ts";

// pnpm release:api: API image を linux/amd64 で build し、公開する image そのもので本番設定の
// フェイルクローズを確かめてから、release-<sha> の tag で ECR に push する。digest は registry から
// 読み直し、dev の terraform.tfvars の api_image に書く。ECS の切り替えは terraform apply に任せる。

const defaultTfvarsPath = fileURLToPath(
  new URL(
    "../infra/terraform/environments/dev/terraform.tfvars",
    import.meta.url,
  ),
);

// environments/dev/variables.tf の api_image の検証から digest 部分を除いたもの。
// ここを通った URL に @sha256:<64hex> を付けたものは、Terraform の検証も通る。
const ecrRepositoryUrlPattern =
  /^([0-9]{12}\.dkr\.ecr\.([a-z]{2}(?:-[a-z0-9]+)+-[0-9])\.amazonaws\.com)\/([a-z0-9]+(?:[-._/][a-z0-9]+)*)$/u;
const verifyContainerNamePattern =
  /^hono-starter-kit-release-verify-[1-9][0-9]*-[0-9a-f]{16}$/u;
const ownerIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
const failureLabel = "release:api and cleanup";

export const parseEcrRepositoryUrl = (repositoryUrl: string) => {
  const match = ecrRepositoryUrlPattern.exec(repositoryUrl);
  if (match === null) {
    throw new Error(
      "--repository-url must be the bootstrap output ecr_repository_url (<account>.dkr.ecr.<region>.amazonaws.com/<repository>).",
    );
  }
  const [, registry = "", region = "", repositoryName = ""] = match;
  return { registry, region, repositoryName, repositoryUrl };
};

const parseReleaseApiArguments = (argv: readonly string[]) => {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      "allow-dirty": { default: false, type: "boolean" },
      "repository-url": { type: "string" },
    },
    strict: true,
  });
  const repositoryUrl = values["repository-url"];
  if (repositoryUrl === undefined) {
    throw new Error(
      "Usage: pnpm release:api --repository-url <bootstrap output ecr_repository_url> [--allow-dirty]",
    );
  }
  return {
    allowDirty: values["allow-dirty"],
    repository: parseEcrRepositoryUrl(repositoryUrl),
  };
};

const assignmentLinePattern = /^\s*api_image\s*=/u;
const simpleAssignmentPattern =
  /^(\s*)api_image(\s*)=(\s*)"[^"\\$%]*"(\s*(?:(?:#|\/\/).*)?)$/u;

// HCL を解釈せずに書き換えるので、1 行の単純な文字列の代入だけを扱う。式や heredoc を
// 推測で書き換えると、運用者が意図した値を壊しかねないため、手で直すよう止める。
export const replaceApiImageAssignment = (
  content: string,
  imageReference: string,
) => {
  const lines = content.split("\n");
  const indexes = lines.flatMap((line, index) =>
    assignmentLinePattern.test(line) ? [index] : [],
  );
  if (indexes.length > 1) {
    throw new Error(
      "The tfvars file has more than one api_image assignment. Keep one and retry.",
    );
  }
  const [index] = indexes;
  if (index === undefined) {
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    return `${content}${separator}api_image = "${imageReference}"\n`;
  }
  const match = simpleAssignmentPattern.exec(lines[index] ?? "");
  if (match === null) {
    throw new Error(
      `api_image is not a single quoted string in the tfvars file. Set it by hand to "${imageReference}".`,
    );
  }
  const [, indent = "", beforeEquals = "", afterEquals = "", trailing = ""] =
    match;
  lines[index] =
    `${indent}api_image${beforeEquals}=${afterEquals}"${imageReference}"${trailing}`;
  return lines.join("\n");
};

const hiddenText = (value: unknown, key: "stderr" | "stdout") => {
  const text = (value as Record<string, unknown> | null)?.[key];
  return typeof text === "string" ? text : "";
};

const exitStatusOf = (error: unknown) => {
  const status = (error as { exitStatus?: unknown } | null)?.exitStatus;
  return typeof status === "number" ? status : undefined;
};

export const createVerifyContainerName = (pid: number) =>
  `hono-starter-kit-release-verify-${pid}-${randomBytes(8).toString("hex")}`;

export const runReleaseApi = async ({
  argv,
  commandRunner = createAsyncCommandRunner(),
  log = (message: string) => {
    console.error(message);
  },
  now = () => new Date(),
  ownerId = randomUUID(),
  print = (message: string) => {
    console.log(message);
  },
  reemitSignal = (signal: NodeJS.Signals) => process.kill(process.pid, signal),
  reportFailure = (failure: unknown) => {
    console.error(failure);
  },
  signalTarget = process,
  tfvarsPath = defaultTfvarsPath,
  verifyContainerName = createVerifyContainerName(process.pid),
}: {
  argv: readonly string[];
  commandRunner?: CommandRunner;
  log?: (message: string) => void;
  now?: () => Date;
  ownerId?: string;
  print?: (message: string) => void;
  reemitSignal?: (signal: NodeJS.Signals) => void;
  reportFailure?: (failure: unknown) => void;
  signalTarget?: SignalTarget;
  tfvarsPath?: string;
  verifyContainerName?: string;
}) => {
  const { allowDirty, repository } = parseReleaseApiArguments(argv);
  // 後片付けは名前とラベルだけを頼りに消すので、所有する形でなければ何も始めない。
  if (
    !verifyContainerNamePattern.test(verifyContainerName) ||
    !ownerIdPattern.test(ownerId)
  ) {
    throw new Error(
      "Refusing to release without an owned verify container name and owner label.",
    );
  }
  const ownerLabel = `hono-starter.release.owner=${ownerId}`;

  const failures: unknown[] = [];
  const interruption = createInterruptionGuard({ commandRunner, signalTarget });
  const interrupted = () => interruption.receivedSignal() !== undefined;
  const runWorkflow = async (
    command: string,
    args: readonly string[],
    options: RunOptions = {},
  ) => {
    interruption.throwIfInterrupted();
    const output = await commandRunner.run(command, args, {
      ...options,
      signal: interruption.signal,
    });
    interruption.throwIfInterrupted();
    return output;
  };

  let localImageMayExist = false;
  let loggedInToRegistry = false;
  let verifyContainerMayExist = false;
  let localReference = "";

  const describePublishedDigest = async (tag: string) => {
    let output;
    try {
      output = await runWorkflow(
        "aws",
        [
          "ecr",
          "describe-images",
          "--region",
          repository.region,
          "--repository-name",
          repository.repositoryName,
          "--image-ids",
          `imageTag=${tag}`,
          "--output",
          "json",
          "--no-cli-pager",
        ],
        { captureStderr: true },
      );
    } catch (error) {
      if (interrupted()) throw error;
      const stderr = hiddenText(error, "stderr");
      if (/\bImageNotFoundException\b/u.test(stderr)) return undefined;
      throw new Error(
        `aws ecr describe-images failed for ${tag}: ${stderr || (error instanceof Error ? error.message : "unknown error")}`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof output === "string" ? output : output.stdout,
      ) as unknown;
    } catch {
      parsed = undefined;
    }
    const result = ecrDescribeImagesSchema.safeParse(parsed);
    const [detail, ...others] = result.success ? result.data.imageDetails : [];
    if (detail === undefined || others.length > 0) {
      throw new Error(`ECR did not return one sha256 digest for ${tag}.`);
    }
    return detail.imageDigest;
  };

  const recordImageReference = async (imageReference: string) => {
    print(`api_image=${imageReference}`);
    let content: string;
    try {
      content = await readFile(tfvarsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // tfvars には api_image 以外の必須の値もあるので、ここで作ると不完全なファイルになる。
      log(
        `${tfvarsPath} was not found. Copy terraform.tfvars.example and set api_image = "${imageReference}".`,
      );
      return;
    }
    const updated = replaceApiImageAssignment(content, imageReference);
    if (updated !== content) await writeFile(tfvarsPath, updated);
    log(
      `Set api_image in ${tfvarsPath}. Apply it with: pnpm terraform -- --root dev apply`,
    );
  };

  const loginToRegistry = async () => {
    let password: string;
    try {
      const output = await runWorkflow(
        "aws",
        [
          "ecr",
          "get-login-password",
          "--region",
          repository.region,
          "--no-cli-pager",
        ],
        { capture: true },
      );
      password = typeof output === "string" ? output : "";
    } catch {
      interruption.throwIfInterrupted();
      // 失敗した子プロセスの stdout に password の一部が残り得るので、元の Error は cause にも付けない。
      throw new Error(
        `Unable to get an ECR login password for ${repository.region}. Check the AWS credentials.`,
      );
    }
    if (password === "") {
      throw new Error(
        `Unable to get an ECR login password for ${repository.region}. Check the AWS credentials.`,
      );
    }
    try {
      await runWorkflow(
        "docker",
        ["login", "--username", "AWS", "--password-stdin", repository.registry],
        { capture: true, stdin: password },
      );
    } catch {
      interruption.throwIfInterrupted();
      // docker login の出力に stdin の password が映り得るので、元の Error は cause にも付けない。
      throw new Error(`docker login to ${repository.registry} failed.`);
    }
    loggedInToRegistry = true;
    log(`Logged in to ${repository.registry}`);
  };

  // check:docker が確かめるのはホストの architecture の image なので、Apple Silicon では
  // 公開する amd64 の image はほかのどこでも検証されない。push の前にここで確かめる。
  const verifyFailClosed = async () => {
    verifyContainerMayExist = true;
    let stdout: string;
    let stderr: string;
    let status = 0;
    try {
      const output = await runWorkflow(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          verifyContainerName,
          "--label",
          ownerLabel,
          "--platform",
          "linux/amd64",
          // ローカルにない場合に registry から同名の image を取ってきて検証してしまわないようにする。
          "--pull",
          "never",
          "--network",
          "none",
          "-e",
          "NODE_ENV=production",
          "-e",
          "AUTH_PROVIDER=dev",
          localReference,
        ],
        { captureStderr: true },
      );
      stdout = hiddenText(output, "stdout");
      stderr = hiddenText(output, "stderr");
    } catch (error) {
      if (interrupted()) throw error;
      stdout = hiddenText(error, "stdout");
      stderr = hiddenText(error, "stderr");
      status = exitStatusOf(error) ?? 0;
    }
    if (status !== 1 || stdout !== "" || stderr !== devAuthRejectionStderr) {
      log(
        `Fail-closed verification exited with status ${status}; stderr: ${stderr || "(empty)"}`,
      );
      throw new Error(
        "The linux/amd64 image did not refuse AUTH_PROVIDER=dev in production. Nothing was pushed.",
      );
    }
    log("Verified that the linux/amd64 image refuses AUTH_PROVIDER=dev");
  };

  const publish = async () => {
    await requireAwsCli(runWorkflow, interrupted);

    const gitState = await readReleaseGitState({
      allowDirty,
      commandRunner: { run: runWorkflow },
      warn: log,
    });
    const { commit, dirty } = gitState;
    // dirty の release も release- で始めて lifecycle の保持対象にし、時刻で IMMUTABLE な tag の衝突を避ける。
    const tag = dirty
      ? `release-${commit}-dirty-${formatUtcTimestamp(now())}`
      : `release-${commit}`;
    localReference = `${repository.repositoryUrl}:${tag}`;

    const existingDigest = await describePublishedDigest(tag);
    if (existingDigest !== undefined) {
      log(`${tag} is already published; reusing its digest without building.`);
      const imageReference = `${repository.repositoryUrl}@${existingDigest}`;
      await recordImageReference(imageReference);
      return { imageReference, reused: true };
    }

    // 後片付けで消すのは、この実行が作った image だけにする。
    const existingImage = await runWorkflow(
      "docker",
      ["image", "ls", "--quiet", "--filter", `reference=${localReference}`],
      { capture: true },
    );
    if (typeof existingImage === "string" && existingImage.trim() !== "") {
      throw new Error(
        `A local image ${localReference} already exists. Remove it with docker image rm ${localReference} and retry.`,
      );
    }

    await loginToRegistry();

    localImageMayExist = true;
    await runWorkflow("docker", [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      "docker/api.Dockerfile",
      "--tag",
      localReference,
      "--load",
      ".",
    ]);
    log(`Built ${localReference}`);

    await verifyFailClosed();

    await assertReleaseGitStateUnchanged({
      before: gitState,
      commandRunner: { run: runWorkflow },
      consequence: "Nothing was pushed.",
    });

    await runWorkflow("docker", ["push", localReference]);

    // buildx の metadata の digest は builder の driver や image store で変わり得るので、registry を正とする。
    const digest = await describePublishedDigest(tag);
    if (digest === undefined) {
      throw new Error(`ECR did not return one sha256 digest for ${tag}.`);
    }
    const imageReference = `${repository.repositoryUrl}@${digest}`;
    await recordImageReference(imageReference);
    return { imageReference, reused: false };
  };

  let result: { imageReference: string; reused: boolean } | undefined;
  try {
    try {
      result = await publish();
    } catch (error) {
      if (!interrupted()) failures.push(error);
    } finally {
      interruption.startCleanup();

      // --rm だけに頼らない。中断で docker run の CLI が先に終わると、コンテナが残り得る。
      if (verifyContainerMayExist) {
        try {
          const owned = await commandRunner.run(
            "docker",
            [
              "container",
              "ls",
              "--all",
              "--quiet",
              "--filter",
              `label=${ownerLabel}`,
              "--filter",
              `name=^/${verifyContainerName}$`,
            ],
            { capture: true },
          );
          if (typeof owned === "string" && owned.trim() !== "") {
            await commandRunner.run(
              "docker",
              ["rm", "-f", verifyContainerName],
              {
                capture: true,
              },
            );
          }
        } catch (error) {
          failures.push(error);
        }
      }

      // build cache は消さない。次の release の build を速くするためで、所有物の判定もできない。
      if (localImageMayExist) {
        try {
          const image = await commandRunner.run(
            "docker",
            [
              "image",
              "ls",
              "--quiet",
              "--filter",
              `reference=${localReference}`,
            ],
            { capture: true },
          );
          if (typeof image === "string" && image.trim() !== "") {
            await commandRunner.run("docker", ["image", "rm", localReference], {
              capture: true,
            });
          }
        } catch (error) {
          failures.push(error);
        }
      }

      // docker login は ~/.docker/config.json（または credential helper）に 12 時間有効な
      // ECR の token を残す。この実行のために得た token なので、終わったら消す。
      if (loggedInToRegistry) {
        try {
          await commandRunner.run("docker", ["logout", repository.registry], {
            capture: true,
          });
        } catch (error) {
          failures.push(error);
        }
      }
    }
  } finally {
    interruption.dispose();
  }

  finishOwnedRun({
    failures,
    label: failureLabel,
    receivedSignal: interruption.receivedSignal(),
    reemitSignal,
    reportFailure,
  });
  return result;
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runReleaseApi({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
