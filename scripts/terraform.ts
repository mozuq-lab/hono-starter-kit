import { spawn } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export const TERRAFORM_IMAGE =
  "hashicorp/terraform:1.15.8@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963";

export const TERRAFORM_ROOTS = Object.freeze({
  dev: "/workspace/infra/terraform/environments/dev",
  bootstrap: "/workspace/infra/terraform/bootstrap",
  "module:network": "/workspace/infra/terraform/modules/network",
  "module:data": "/workspace/infra/terraform/modules/data",
  "module:ingress": "/workspace/infra/terraform/modules/ingress",
  "module:edge": "/workspace/infra/terraform/modules/edge",
  "module:identity": "/workspace/infra/terraform/modules/identity",
  "module:workload": "/workspace/infra/terraform/modules/workload",
});

export const parseTerraformInvocation = (argv: readonly string[]) => {
  const invocation = argv[0] === "--" ? argv.slice(1) : [...argv];
  const root = invocation[0] === "--root" ? invocation.splice(0, 2)[1] : "dev";
  if (root === undefined || !Object.hasOwn(TERRAFORM_ROOTS, root)) {
    throw new Error(
      "Unknown Terraform root. Use --root with a logical root name.",
    );
  }
  if (invocation.some((arg) => /^(?:--root|-chdir)(?:=|$)/u.test(arg))) {
    throw new Error("Terraform root cannot be overridden or repeated.");
  }
  const [command, ...args] = invocation;
  if (command === undefined) throw new Error("Missing Terraform command.");
  return { root: root as keyof typeof TERRAFORM_ROOTS, command, args };
};

type CommandOptions = {
  environment?: NodeJS.ProcessEnv | undefined;
  capture?: boolean | undefined;
  signal?: AbortSignal | undefined;
};

export type TerraformCommandRunner = {
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<string>;
};

const failure = (message: string, exitStatus = 1, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { exitStatus });
const abortFailure = (signal: AbortSignal) =>
  failure("Terraform interrupted.", signal.reason === "SIGINT" ? 130 : 143);

export const createTerraformCommandRunner = (): TerraformCommandRunner => ({
  async run(
    command,
    args,
    { environment = process.env, capture = false, signal } = {},
  ) {
    if (signal?.aborted) throw abortFailure(signal);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        env: environment,
        shell: false,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let stdout = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      // 捕捉した診断には state や credentials が含まれ得るため、Error に保持しない。
      child.stderr?.resume();
      const onAbort = () => {
        child.kill(signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const removeListener = () =>
        signal?.removeEventListener("abort", onAbort);
      child.once("error", () => {
        removeListener();
        reject(failure("Unable to start command."));
      });
      child.once("close", (status, receivedSignal) => {
        removeListener();
        if (signal?.aborted) reject(abortFailure(signal));
        else if (status === 0) resolve(stdout);
        else
          reject(
            failure(
              "Command failed.",
              status ?? (receivedSignal === "SIGINT" ? 130 : 143),
            ),
          );
      });
      if (signal?.aborted) onAbort();
    });
  },
});

const containerEnvironmentNames = new Set([
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_EC2_METADATA_DISABLED",
  "CHECKPOINT_DISABLE",
]);

export const runTerraform = async ({
  argv,
  environment = process.env,
  repositoryRoot = defaultRepositoryRoot,
  commandRunner = createTerraformCommandRunner(),
  capture = false,
  signal,
}: {
  argv: readonly string[];
  environment?: NodeJS.ProcessEnv | undefined;
  repositoryRoot?: string | undefined;
  commandRunner?: TerraformCommandRunner | undefined;
  capture?: boolean | undefined;
  signal?: AbortSignal | undefined;
}): Promise<string> => {
  const invocation = parseTerraformInvocation(argv);
  const containerName =
    environment.TERRAFORM_CONTAINER_NAME ??
    `hono-starter-terraform-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(containerName))
    throw failure("Invalid Terraform container name.");
  const ownershipLabel = `hono-starter.terraform.owner=${environment.TERRAFORM_CONTAINER_OWNER ?? randomUUID()}`;
  const dockerEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    TF_INPUT: environment.TF_INPUT ?? "0",
    CHECKPOINT_DISABLE: environment.CHECKPOINT_DISABLE ?? "1",
    AWS_EC2_METADATA_DISABLED: environment.AWS_EC2_METADATA_DISABLED ?? "true",
  };
  for (const name of Object.keys(dockerEnvironment)) {
    if (name.startsWith("AWS_") && !containerEnvironmentNames.has(name)) {
      delete dockerEnvironment[name];
    }
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  const onSigint = () => controller.abort("SIGINT");
  const onSigterm = () => controller.abort("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (signal?.aborted) onAbort();

  let temporaryAwsDirectory: string | undefined;
  let started = false;
  let succeeded = false;
  let operationStatus = 1;
  let operationError: Error | undefined;
  let output = "";
  try {
    if (controller.signal.aborted) throw abortFailure(controller.signal);
    let awsDirectory = environment.TERRAFORM_AWS_DIR;
    const accessKey = environment.AWS_ACCESS_KEY_ID;
    const secretKey = environment.AWS_SECRET_ACCESS_KEY;
    const token = environment.AWS_SESSION_TOKEN;
    if (
      awsDirectory === undefined &&
      (accessKey !== undefined ||
        secretKey !== undefined ||
        token !== undefined)
    ) {
      if (
        !accessKey ||
        !secretKey ||
        [accessKey, secretKey, token].some(
          (value) => value !== undefined && /[\r\n]/u.test(value),
        )
      ) {
        throw failure("AWS environment credentials are incomplete or invalid.");
      }
      temporaryAwsDirectory = await fs.mkdtemp(
        path.join(tmpdir(), "hono-starter-terraform-aws-"),
      );
      await fs.writeFile(
        path.join(temporaryAwsDirectory, "credentials"),
        `[default]\naws_access_key_id = ${accessKey}\naws_secret_access_key = ${secretKey}\n${token ? `aws_session_token = ${token}\n` : ""}`,
        { mode: 0o600 },
      );
      awsDirectory = temporaryAwsDirectory;
      dockerEnvironment.AWS_PROFILE = "default";
      delete dockerEnvironment.AWS_DEFAULT_PROFILE;
    } else if (awsDirectory === undefined) {
      const sharedDirectory = path.join(environment.HOME ?? homedir(), ".aws");
      try {
        if ((await fs.stat(sharedDirectory)).isDirectory())
          awsDirectory = sharedDirectory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw failure("Unable to access the AWS directory.");
      }
    }
    const mount = (source: string, target: string, readonly = false) => {
      if (source.includes(","))
        throw failure("Terraform mount paths cannot contain commas.");
      return `type=bind,source=${path.resolve(source)},target=${target}${readonly ? ",readonly" : ""}`;
    };
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--label",
      ownershipLabel,
    ];
    if (!capture) args.push("--interactive");
    if (!capture && process.stdin.isTTY && process.stdout.isTTY)
      args.push("--tty");
    if (process.getuid && process.getgid)
      args.push("--user", `${process.getuid()}:${process.getgid()}`);
    args.push(
      "--env",
      "HOME=/terraform",
      "--mount",
      mount(
        environment.TERRAFORM_SOURCE_DIR ??
          path.join(repositoryRoot, "infra/terraform"),
        "/workspace/infra/terraform",
      ),
    );
    if (awsDirectory !== undefined) {
      if (!(await fs.stat(awsDirectory)).isDirectory())
        throw failure("Terraform AWS path must be a directory.");
      args.push("--mount", mount(awsDirectory, "/terraform/.aws", true));
    }
    for (const [name, value] of Object.entries(dockerEnvironment)) {
      if (
        value !== undefined &&
        (containerEnvironmentNames.has(name) || name.startsWith("TF_"))
      )
        args.push("--env", name);
    }
    args.push(
      environment.TERRAFORM_IMAGE ?? TERRAFORM_IMAGE,
      `-chdir=${TERRAFORM_ROOTS[invocation.root]}`,
      invocation.command,
      ...invocation.args,
    );
    if (controller.signal.aborted) throw abortFailure(controller.signal);
    started = true;
    output = await commandRunner.run("docker", args, {
      environment: dockerEnvironment,
      capture,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw abortFailure(controller.signal);
    succeeded = true;
  } catch (error) {
    operationError =
      error instanceof Error ? error : failure("Terraform failed.");
    const status = (operationError as Error & { exitStatus?: unknown })
      .exitStatus;
    if (typeof status === "number" && Number.isInteger(status))
      operationStatus = status;
    if (
      capture &&
      invocation.command === "state" &&
      invocation.args[0] === "pull"
    ) {
      operationError = failure(
        `${operationError.message}\nUnable to read ${invocation.root} Terraform state. Check backend initialization and AWS access with: pnpm terraform -- --root ${invocation.root} state list`,
        operationStatus,
        operationError,
      );
    }
  } finally {
    try {
      if (started && !succeeded) {
        // 名前の衝突で失敗した場合に、既存の別 container を削除しない。
        try {
          const ownedNames = await commandRunner.run(
            "docker",
            [
              "container",
              "ls",
              "--all",
              "--filter",
              `label=${ownershipLabel}`,
              "--format",
              "{{.Names}}",
            ],
            { environment: dockerEnvironment, capture: true },
          );
          if (ownedNames.split(/\r?\n/u).includes(containerName)) {
            await commandRunner.run(
              "docker",
              ["rm", "--force", containerName],
              { environment: dockerEnvironment, capture: true },
            );
          }
        } catch {
          operationError = failure(
            `${operationError?.message ?? "Terraform failed."}\nTerraform container cleanup failed: ${containerName}.`,
            operationStatus,
            operationError,
          );
        }
      }
    } finally {
      try {
        if (temporaryAwsDirectory !== undefined)
          await fs.rm(temporaryAwsDirectory, { recursive: true, force: true });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  return output;
};

export const reportTerraformFailure = (error: unknown) => {
  console.error(error instanceof Error ? error.message : "Terraform failed.");
  const status = (error as { exitStatus?: unknown } | undefined)?.exitStatus;
  process.exitCode =
    typeof status === "number" && Number.isInteger(status) ? status : 1;
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runTerraform({ argv: process.argv.slice(2) }).catch(
    reportTerraformFailure,
  );
}
