import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { TERRAFORM_IMAGE, TERRAFORM_ROOTS } from "../terraform.ts";

const defaultRepositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const pinnedReference = TERRAFORM_IMAGE.replace(/:[^/@]+@/u, "@");

type CommandRunner = {
  run(
    command: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ): Promise<string | { stdout: string; stderr: string }>;
};

const copyTrackedSource = async (
  repositoryRoot: string,
  destination: string,
  trackedOutput: string,
) => {
  // backend.hcl や runtime artifact を拡張子だけで拾わず、実行に必要なソースに限定する。
  const files = new Set(
    trackedOutput
      .split("\0")
      .filter(
        (entry) =>
          entry.startsWith("infra/terraform/") &&
          path.posix.normalize(entry) === entry &&
          !entry.includes("\\") &&
          entry
            .split("/")
            .every(
              (part) => !part.startsWith(".") || part === ".terraform.lock.hcl",
            ) &&
          /(?:\.tf|\.tftest\.hcl|\/\.terraform\.lock\.hcl|\.m?js)$/u.test(
            entry,
          ),
      )
      .map((entry) => entry.slice("infra/terraform/".length)),
  );
  const source = path.join(repositoryRoot, "infra/terraform");
  if (!(await fs.lstat(source)).isDirectory())
    throw new Error("Terraform source must be a directory.");
  const copyDirectory = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(source, relative), {
      withFileTypes: true,
    })) {
      const name = path.posix.join(relative, entry.name);
      const target = path.join(destination, name);
      if (
        entry.isDirectory() &&
        [...files].some((file) => file.startsWith(`${name}/`))
      ) {
        await fs.mkdir(target, { recursive: true });
        await copyDirectory(name);
      } else if (files.has(name)) {
        if (!entry.isFile())
          throw new Error("Terraform tracked source must be a regular file.");
        await fs.copyFile(path.join(source, name), target);
      }
    }
  };
  await copyDirectory("");
};

export const createTerraformDockerVerification = ({
  commandRunner,
  environment = process.env,
  log = () => undefined,
  onCleanupStart = () => undefined,
  projectName,
  repositoryRoot = defaultRepositoryRoot,
  signal = new AbortController().signal,
}: {
  commandRunner: CommandRunner;
  environment?: NodeJS.ProcessEnv | undefined;
  log?: ((message: string) => void) | undefined;
  onCleanupStart?: (() => void) | undefined;
  projectName: string;
  repositoryRoot?: string | undefined;
  signal?: AbortSignal | undefined;
}) => {
  if (
    !/^hono-starter-kit-terraform-test-[a-z0-9-]+$/u.test(projectName) ||
    projectName.length > 128
  ) {
    throw new Error(
      "Terraform Docker acceptance requires an owned project name.",
    );
  }
  const imageName = `${projectName}-image:verify`;
  const containerName = `${projectName}-container`;
  const containerOwner = randomUUID();
  const cleanEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !/^(?:AWS_|TF_|TERRAFORM_)/u.test(name),
    ),
  );
  let temporaryDirectory: string | undefined;
  let imageOwned = false;
  let containerOwned = false;
  let baseImageOwned = false;
  let cleanupPromise: Promise<void> | undefined;
  let verificationPromise: Promise<void> | undefined;

  const run = async (
    command: string,
    args: readonly string[],
    cleanup = false,
  ): Promise<string> => {
    if (!cleanup) signal.throwIfAborted();
    const output = await commandRunner.run(command, args, {
      capture: true,
      environment: cleanEnvironment,
      ...(cleanup ? {} : { signal }),
    });
    if (!cleanup) signal.throwIfAborted();
    return typeof output === "string" ? output : output.stdout;
  };
  const containerQuery = [
    "container",
    "ls",
    "-aq",
    "--no-trunc",
    "--filter",
    `name=^/${containerName}$`,
  ];
  const ownedContainerQuery = [
    ...containerQuery,
    "--filter",
    `label=hono-starter.terraform.owner=${containerOwner}`,
  ];
  const imageQuery = [
    "image",
    "ls",
    "--quiet",
    "--no-trunc",
    "--filter",
    `reference=${imageName}`,
  ];
  const baseImageQuery = [
    "image",
    "ls",
    "--digests",
    "--format",
    "{{.Repository}}@{{.Digest}}",
  ];
  const hasBaseImage = async (cleanup = false) =>
    (await run("docker", baseImageQuery, cleanup))
      .split(/\r?\n/u)
      .includes(pinnedReference);

  const cleanupOwnedResources = async () => {
    onCleanupStart();
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (containerOwned) {
      await attempt(async () => {
        if ((await run("docker", ownedContainerQuery, true)).trim() !== "") {
          await run(
            "docker",
            ["container", "rm", "--force", containerName],
            true,
          );
        }
        if ((await run("docker", ownedContainerQuery, true)).trim() !== "")
          throw new Error("Terraform Docker cleanup left a container.");
      });
    }
    if (imageOwned) {
      await attempt(async () => {
        if ((await run("docker", imageQuery, true)).trim() !== "")
          await run("docker", ["image", "rm", imageName], true);
        if ((await run("docker", imageQuery, true)).trim() !== "")
          throw new Error("Terraform Docker cleanup left an image.");
      });
    }
    if (baseImageOwned) {
      await attempt(async () => {
        if (await hasBaseImage(true))
          await run("docker", ["image", "rm", TERRAFORM_IMAGE], true);
        if (await hasBaseImage(true))
          throw new Error("Terraform Docker cleanup left a pulled image.");
      });
    }
    if (temporaryDirectory !== undefined) {
      const ownedDirectory = temporaryDirectory;
      await attempt(async () => {
        await fs.rm(ownedDirectory, { recursive: true, force: true });
        try {
          await fs.lstat(ownedDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        throw new Error("Terraform Docker cleanup left a temporary directory.");
      });
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Terraform Docker cleanup failed.");
    log(`Removed Terraform Docker acceptance resources for ${projectName}`);
  };
  const cleanup = () => (cleanupPromise ??= cleanupOwnedResources());

  const performVerification = async () => {
    signal.throwIfAborted();
    temporaryDirectory = await fs.mkdtemp(
      path.join(tmpdir(), `${projectName}-`),
    );
    const sourceDirectory = path.join(temporaryDirectory, "source");
    const awsDirectory = path.join(temporaryDirectory, "aws");
    for (const directory of [sourceDirectory, awsDirectory])
      await fs.mkdir(directory);
    Object.assign(cleanEnvironment, {
      AWS_EC2_METADATA_DISABLED: "true",
      CHECKPOINT_DISABLE: "1",
      TF_INPUT: "0",
      TERRAFORM_SOURCE_DIR: sourceDirectory,
      TERRAFORM_AWS_DIR: awsDirectory,
      TERRAFORM_IMAGE: imageName,
      TERRAFORM_CONTAINER_NAME: containerName,
      TERRAFORM_CONTAINER_OWNER: containerOwner,
    });
    const tracked = await run("git", [
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
      "--",
      "infra/terraform",
    ]);
    await copyTrackedSource(repositoryRoot, sourceDirectory, tracked);
    if (
      (await run("docker", containerQuery)).trim() !== "" ||
      (await run("docker", imageQuery)).trim() !== ""
    ) {
      throw new Error("Terraform Docker acceptance resource already exists.");
    }
    baseImageOwned = !(await hasBaseImage());
    if (baseImageOwned) await run("docker", ["pull", TERRAFORM_IMAGE]);
    imageOwned = true;
    await run("docker", ["tag", TERRAFORM_IMAGE, imageName]);
    const terraform = async (root: string, args: readonly string[]) => {
      containerOwned = true;
      return run("pnpm", ["terraform", "--", "--root", root, ...args]);
    };
    const version = await terraform("bootstrap", ["version"]);
    if (!/^Terraform v1\.15\.8\r?$/mu.test(version))
      throw new Error("Expected Terraform v1.15.8.");
    for (const root of Object.keys(TERRAFORM_ROOTS)) {
      log(`Verifying Terraform root ${root}`);
      await terraform(root, ["init", "-backend=false", "-lockfile=readonly"]);
      await terraform(root, ["validate"]);
      await terraform(root, ["test"]);
    }
    await run(process.execPath, [
      "--test",
      path.join(
        repositoryRoot,
        "scripts/terraform-foundation-plan.acceptance.ts",
      ),
    ]);
    if ((await run("docker", ownedContainerQuery)).trim() !== "")
      throw new Error("Terraform Docker verification left a container.");
    log(`Verified Terraform Docker acceptance for ${projectName}`);
  };
  const verify = () =>
    (verificationPromise ??= (async () => {
      try {
        await performVerification();
      } catch (error) {
        let cleanupFailure: unknown;
        try {
          await cleanup();
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
        if (cleanupFailure !== undefined) {
          throw new AggregateError(
            [error, cleanupFailure],
            "Terraform Docker verification and cleanup failed.",
            { cause: error },
          );
        }
        throw error;
      }
    })());
  return Object.freeze({ verify, cleanup });
};
