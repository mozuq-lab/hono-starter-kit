import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import {
  parseEcrRepositoryUrl,
  replaceApiImageAssignment,
  runReleaseApi,
} from "./release-api.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const repositoryUrl =
  "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api";
const registry = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com";
const releaseTag = `release-${commit}`;
const localReference = `${repositoryUrl}:${releaseTag}`;
const pushedDigest = `sha256:${"b".repeat(64)}`;
const existingDigest = `sha256:${"c".repeat(64)}`;
const ecrPassword = "ecr-login-password-that-must-stay-secret";
const verifyContainerName =
  "hono-starter-kit-release-verify-4321-0011223344556677";
const ownerLabel = "hono-starter.release.owner=fixture-owner";
const devAuthRejection =
  "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production";
// environments/dev/variables.tf の api_image の検証と同じ正規表現。
const terraformApiImagePattern =
  /^[0-9]{12}\.dkr\.ecr\.[a-z]{2}(-[a-z0-9]+)+-[0-9]\.amazonaws\.com\/[a-z0-9]+([-._/][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;

type Call = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
};

const commandFailure = ({
  stderr = "",
  stdout = "",
  status = 1,
}: {
  stderr?: string;
  stdout?: string;
  status?: number;
}) => {
  const error = new Error(`command exited with status ${status}`);
  Object.defineProperties(error, {
    exitStatus: { value: status },
    stderr: { value: stderr },
    stdout: { value: stdout },
  });
  return error;
};

const describeImagesOutput = (digest: string, tag: string) =>
  JSON.stringify({
    imageDetails: [
      {
        imageDigest: digest,
        imageTags: [tag],
        repositoryName: "hono-starter-kit-dev-api",
      },
    ],
  });

const imageNotFound = () =>
  commandFailure({
    stderr:
      "An error occurred (ImageNotFoundException) when calling the DescribeImages operation: The image with imageId {imageTag:'release-x'} does not exist",
    status: 254,
  });

const isCall =
  (command: string, ...prefix: string[]) =>
  (call: Call) =>
    call.command === command &&
    prefix.every((argument, index) => call.args[index] === argument);

const isDescribeImages = isCall("aws", "ecr", "describe-images");
const isLoginPassword = isCall("aws", "ecr", "get-login-password");
const isDockerLogin = isCall("docker", "login");
const isDockerLogout = isCall("docker", "logout");
const isBuild = isCall("docker", "buildx", "build");
const isVerifyRun = isCall("docker", "run");
const isPush = isCall("docker", "push");
const isContainerList = isCall("docker", "container", "ls");
const isContainerRemove = isCall("docker", "rm", "-f");
const isImageList = isCall("docker", "image", "ls");
const isImageRemove = isCall("docker", "image", "rm");

type Handler = (call: Call) => Promise<unknown> | undefined;

// 既定では「未公開 → build → 検証は期待どおり拒否 → push → registry に digest」の流れを返す。
// handler が値を返した呼び出しだけ既定を上書きする。
const createFakeRunner = ({
  handler = () => undefined,
  porcelain = "",
  published = false,
}: {
  handler?: Handler;
  porcelain?: string;
  published?: boolean;
} = {}) => {
  const calls: Call[] = [];
  const terminated: NodeJS.Signals[] = [];
  let pushed = false;
  let containerExists = false;
  let imageExists = false;
  let rejectActive: ((error: unknown) => void) | undefined;

  const defaultResponse = (call: Call): Promise<unknown> => {
    if (isCall("aws", "--version")(call))
      return Promise.resolve("aws-cli/2.31.0");
    if (isCall("git", "rev-parse")(call)) return Promise.resolve(`${commit}\n`);
    if (isCall("git", "status")(call)) return Promise.resolve(porcelain);
    if (isDescribeImages(call)) {
      if (published) {
        return Promise.resolve({
          stderr: "",
          stdout: describeImagesOutput(existingDigest, releaseTag),
        });
      }
      if (!pushed) return Promise.reject(imageNotFound());
      const tag = call.args[call.args.indexOf("--image-ids") + 1]?.replace(
        "imageTag=",
        "",
      );
      return Promise.resolve({
        stderr: "",
        stdout: describeImagesOutput(pushedDigest, tag ?? ""),
      });
    }
    if (isLoginPassword(call)) return Promise.resolve(ecrPassword);
    if (isDockerLogin(call)) return Promise.resolve("Login Succeeded");
    if (isDockerLogout(call))
      return Promise.resolve(`Removing login credentials for ${registry}`);
    if (isBuild(call)) {
      imageExists = true;
      return Promise.resolve("");
    }
    if (isVerifyRun(call)) {
      containerExists = true;
      return Promise.reject(commandFailure({ stderr: devAuthRejection }));
    }
    if (isPush(call)) {
      pushed = true;
      return Promise.resolve("");
    }
    if (isContainerList(call))
      return Promise.resolve(containerExists ? verifyContainerName : "");
    if (isContainerRemove(call)) {
      containerExists = false;
      return Promise.resolve("");
    }
    if (isImageList(call))
      return Promise.resolve(imageExists ? "sha256:local" : "");
    if (isImageRemove(call)) {
      imageExists = false;
      return Promise.resolve("");
    }
    return Promise.reject(
      new Error(`Unexpected command ${call.command} ${call.args.join(" ")}`),
    );
  };

  return {
    calls,
    terminated,
    setContainerExists(value: boolean) {
      containerExists = value;
    },
    setImageExists(value: boolean) {
      imageExists = value;
    },
    commandRunner: {
      run(
        command: string,
        args: readonly string[],
        options: Record<string, unknown> = {},
      ) {
        const call = { args, command, options };
        calls.push(call);
        const handled = handler(call);
        const response = handled ?? defaultResponse(call);
        return new Promise<string | { stdout: string; stderr: string }>(
          (resolve, reject) => {
            rejectActive = reject;
            response.then(
              (value) =>
                resolve(value as string | { stdout: string; stderr: string }),
              reject,
            );
          },
        );
      },
      terminateActiveChild(signal: NodeJS.Signals) {
        terminated.push(signal);
        rejectActive?.(new Error(`terminated by ${signal}`));
        return true;
      },
    },
  };
};

const withTfvars = async (
  content: string | undefined,
  body: (path: string) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "release-api-test-"));
  const path = join(directory, "terraform.tfvars");
  try {
    if (content !== undefined) await writeFile(path, content);
    await body(path);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const baseOptions = (tfvarsPath: string) => {
  const printed: string[] = [];
  const logs: string[] = [];
  return {
    logs,
    printed,
    options: {
      argv: ["--repository-url", repositoryUrl],
      log: (message: string) => logs.push(message),
      now: () => new Date("2026-09-29T01:02:03.000Z"),
      ownerId: "fixture-owner",
      print: (message: string) => printed.push(message),
      reemitSignal: () => undefined,
      reportFailure: () => undefined,
      signalTarget: new EventEmitter(),
      tfvarsPath,
      verifyContainerName,
    },
  };
};

const waitFor = async (predicate: () => boolean) => {
  while (!predicate()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

test("release-api builds linux/amd64 and tags release-<sha>", async () => {
  await withTfvars('project = "hono-starter-kit"\n', async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner();
    const { options } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner });

    const build = calls.find(isBuild);
    assert.deepEqual(build?.args, [
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
    assert.deepEqual(calls.find(isPush)?.args, ["push", localReference]);
  });
});

test("release-api runs describe, login, build, verify, push, and describe in that order", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner();
    const { options } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner });

    const steps = calls
      .map((call) =>
        isDescribeImages(call)
          ? "describe"
          : isLoginPassword(call)
            ? "password"
            : isDockerLogin(call)
              ? "login"
              : isBuild(call)
                ? "build"
                : isVerifyRun(call)
                  ? "verify"
                  : isPush(call)
                    ? "push"
                    : undefined,
      )
      .filter((step) => step !== undefined);
    assert.deepEqual(steps, [
      "describe",
      "password",
      "login",
      "build",
      "verify",
      "push",
      "describe",
    ]);
    const describe = calls.find(isDescribeImages);
    assert.deepEqual(describe?.args, [
      "ecr",
      "describe-images",
      "--region",
      "ap-northeast-1",
      "--repository-name",
      "hono-starter-kit-dev-api",
      "--image-ids",
      `imageTag=${releaseTag}`,
      "--output",
      "json",
      "--no-cli-pager",
    ]);
  });
});

test("release-api requires the AWS CLI before touching git or docker", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: (call) =>
        isCall("aws", "--version")(call)
          ? Promise.reject(new Error("Unable to start aws"))
          : undefined,
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(runReleaseApi({ ...options, commandRunner }), {
      message:
        "The AWS CLI (aws) is required to publish to AWS. Install it and configure credentials.",
    });
    assert.equal(calls.length, 1);
  });
});

test("release-api refuses a dirty working tree before calling AWS or docker", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner({
      porcelain: " M apps/api-node/src/server.ts\n",
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner }),
      /--allow-dirty/u,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.command === "docker" ||
          isDescribeImages(call) ||
          isLoginPassword(call),
      ),
      false,
    );
  });
});

test("release-api tags a dirty release with a unique release- tag", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner({
      porcelain: " M README.md\n",
    });
    const { logs, options } = baseOptions(tfvarsPath);

    await runReleaseApi({
      ...options,
      argv: ["--", "--repository-url", repositoryUrl, "--allow-dirty"],
      commandRunner,
    });

    const dirtyReference = `${repositoryUrl}:release-${commit}-dirty-20260929010203`;
    assert.equal(calls.find(isBuild)?.args.includes(dirtyReference), true);
    assert.deepEqual(calls.find(isPush)?.args, ["push", dirtyReference]);
    assert.ok(logs.some((message) => /uncommitted changes/u.test(message)));
  });
});

test("release-api reuses the digest of an already published commit", async () => {
  await withTfvars(
    `api_image = "${repositoryUrl}@sha256:${"a".repeat(64)}"\n`,
    async (tfvarsPath) => {
      const { calls, commandRunner } = createFakeRunner({ published: true });
      const { options, printed } = baseOptions(tfvarsPath);

      const result = await runReleaseApi({ ...options, commandRunner });

      assert.equal(
        result?.imageReference,
        `${repositoryUrl}@${existingDigest}`,
      );
      assert.deepEqual(printed, [
        `api_image=${repositoryUrl}@${existingDigest}`,
      ]);
      assert.equal(
        calls.some((call) => call.command === "docker"),
        false,
      );
      assert.equal(calls.some(isLoginPassword), false);
      assert.equal(
        await readFile(tfvarsPath, "utf8"),
        `api_image = "${repositoryUrl}@${existingDigest}"\n`,
      );
    },
  );
});

test("release-api stops on a describe-images error other than ImageNotFoundException", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: (call) =>
        isDescribeImages(call)
          ? Promise.reject(
              commandFailure({
                stderr:
                  "An error occurred (RepositoryNotFoundException) when calling the DescribeImages operation",
                status: 254,
              }),
            )
          : undefined,
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner }),
      /RepositoryNotFoundException/u,
    );
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
    );
  });
});

test("release-api verifies the amd64 image fails closed before pushing", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner();
    const { options } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner });

    assert.deepEqual(calls.find(isVerifyRun)?.args, [
      "run",
      "--rm",
      "--name",
      verifyContainerName,
      "--label",
      ownerLabel,
      "--platform",
      "linux/amd64",
      "--pull",
      "never",
      "--network",
      "none",
      "-e",
      "NODE_ENV=production",
      "-e",
      "AUTH_PROVIDER=dev",
      localReference,
    ]);
  });
});

// 応答は呼ばれたときに作る。先に Promise.reject を作ると、未処理の rejection になる。
for (const [label, verifyResponse] of [
  ["the image starts with the dev identity adapter", () => Promise.resolve("")],
  [
    "the image fails for a different reason",
    () =>
      Promise.reject(
        commandFailure({
          stderr: "exec /usr/local/bin/node: exec format error",
        }),
      ),
  ],
  [
    "the rejection also writes to stdout",
    () =>
      Promise.reject(
        commandFailure({ stderr: devAuthRejection, stdout: "listening" }),
      ),
  ],
] as const) {
  test(`release-api does not push when ${label}`, async () => {
    await withTfvars("", async (tfvarsPath) => {
      const { calls, commandRunner } = createFakeRunner({
        handler: (call) => (isVerifyRun(call) ? verifyResponse() : undefined),
      });
      const { options, printed } = baseOptions(tfvarsPath);

      await assert.rejects(runReleaseApi({ ...options, commandRunner }), {
        message:
          "The linux/amd64 image did not refuse AUTH_PROVIDER=dev in production. Nothing was pushed.",
      });
      assert.equal(calls.some(isPush), false);
      assert.deepEqual(printed, []);
      assert.equal(await readFile(tfvarsPath, "utf8"), "");
      assert.deepEqual(calls.find(isImageRemove)?.args, [
        "image",
        "rm",
        localReference,
      ]);
    });
  });
}

// 状態を確かめてから push までの間に作業ツリーが変わると、tag の commit と image の中身がずれる。
for (const [label, statuses, argv] of [
  ["a clean tree gains a change", ["", " M apps/api-node/src/server.ts\n"], []],
  [
    "a dirty tree changes further",
    [" M README.md\n", " M README.md\n?? extra.ts\n"],
    ["--allow-dirty"],
  ],
] as const) {
  test(`release-api does not push when ${label} during the build`, async () => {
    await withTfvars("", async (tfvarsPath) => {
      let statusCount = 0;
      const { calls, commandRunner } = createFakeRunner({
        handler: (call) => {
          if (!isCall("git", "status")(call)) return undefined;
          const value = statuses[Math.min(statusCount, statuses.length - 1)];
          statusCount += 1;
          return Promise.resolve(value);
        },
      });
      const { options, printed } = baseOptions(tfvarsPath);

      await assert.rejects(
        runReleaseApi({
          ...options,
          argv: ["--repository-url", repositoryUrl, ...argv],
          commandRunner,
        }),
        {
          message:
            "The working tree changed while the release was being built. Nothing was pushed.",
        },
      );
      const statusCalls = calls.filter(isCall("git", "status"));
      assert.equal(statusCalls.length, 2);
      assert.ok(
        calls.indexOf(statusCalls[1] as Call) > calls.findIndex(isBuild),
      );
      assert.equal(calls.some(isPush), false);
      assert.deepEqual(printed, []);
      assert.ok(calls.some(isImageRemove));
    });
  });
}

test("release-api reads the digest from the registry after pushing", async () => {
  await withTfvars('project = "hono-starter-kit"\n', async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner();
    const { options, printed } = baseOptions(tfvarsPath);

    const result = await runReleaseApi({ ...options, commandRunner });
    assert.ok(result);

    const describes = calls.filter(isDescribeImages);
    assert.equal(describes.length, 2);
    assert.ok(calls.indexOf(describes[1] as Call) > calls.findIndex(isPush));
    assert.equal(result.imageReference, `${repositoryUrl}@${pushedDigest}`);
    assert.match(result.imageReference, terraformApiImagePattern);
    assert.deepEqual(printed, [`api_image=${repositoryUrl}@${pushedDigest}`]);
    assert.equal(
      await readFile(tfvarsPath, "utf8"),
      `project = "hono-starter-kit"\napi_image = "${repositoryUrl}@${pushedDigest}"\n`,
    );
  });
});

test("release-api refuses a registry digest that is not a lowercase sha256", async () => {
  await withTfvars("", async (tfvarsPath) => {
    let describeCount = 0;
    const { commandRunner } = createFakeRunner({
      handler: (call) => {
        if (!isDescribeImages(call)) return undefined;
        describeCount += 1;
        if (describeCount === 1) return Promise.reject(imageNotFound());
        return Promise.resolve({
          stderr: "",
          stdout: describeImagesOutput("sha256:NOTHEX", releaseTag),
        });
      },
    });
    const { options, printed } = baseOptions(tfvarsPath);

    await assert.rejects(runReleaseApi({ ...options, commandRunner }), {
      message: `ECR did not return one sha256 digest for ${releaseTag}.`,
    });
    assert.deepEqual(printed, []);
  });
});

test("release-api passes the ECR password only through stdin", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner();
    const { logs, options, printed } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner });

    const login = calls.find(isDockerLogin);
    assert.deepEqual(login?.args, [
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      registry,
    ]);
    assert.equal(login?.options.stdin, ecrPassword);
    for (const call of calls) {
      assert.equal(call.args.join(" ").includes(ecrPassword), false);
      const environment = call.options.environment as
        Record<string, unknown> | undefined;
      assert.equal(
        JSON.stringify(environment ?? {}).includes(ecrPassword),
        false,
      );
      if (call !== login) {
        assert.equal(
          JSON.stringify(call.options.stdin ?? "").includes(ecrPassword),
          false,
        );
      }
    }
    assert.equal([...logs, ...printed].join("\n").includes(ecrPassword), false);
  });
});

const assertSecretFree = (error: unknown) => {
  const rendered = [
    inspect(error, { depth: 10, showHidden: true }),
    error instanceof Error ? (error.stack ?? "") : "",
    JSON.stringify(error),
  ].join("\n");
  assert.equal(rendered.includes(ecrPassword), false);
  let current: unknown = error;
  while (current instanceof Error) {
    assert.equal(current.message.includes(ecrPassword), false);
    current = current.cause;
  }
  return true;
};

test("a failed docker login never carries the ECR password in the error", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: (call) =>
        isDockerLogin(call)
          ? Promise.reject(
              commandFailure({
                stderr: `Error: cannot log in with ${ecrPassword}`,
                stdout: ecrPassword,
              }),
            )
          : undefined,
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `docker login to ${registry} failed.`);
        return assertSecretFree(error);
      },
    );
    assert.equal(calls.some(isBuild), false);
  });
});

test("a failed get-login-password never carries partial output in the error", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { commandRunner } = createFakeRunner({
      handler: (call) =>
        isLoginPassword(call)
          ? Promise.reject(commandFailure({ stdout: ecrPassword }))
          : undefined,
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Unable to get an ECR login password for ap-northeast-1. Check the AWS credentials.",
        );
        return assertSecretFree(error);
      },
    );
  });
});

test("release-api removes the local image and the owned verify container after success", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const fake = createFakeRunner();
    const { options } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner: fake.commandRunner });

    const containerList = fake.calls.find(isContainerList);
    assert.deepEqual(containerList?.args, [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=${ownerLabel}`,
      "--filter",
      `name=^/${verifyContainerName}$`,
    ]);
    assert.deepEqual(fake.calls.find(isImageRemove)?.args, [
      "image",
      "rm",
      localReference,
    ]);
    assert.ok(
      fake.calls.findIndex(isImageRemove) > fake.calls.findIndex(isPush),
    );
  });
});

test("release-api logs out of the registry after the push", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const fake = createFakeRunner();
    const { logs, options, printed } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner: fake.commandRunner });

    const logouts = fake.calls.filter(isDockerLogout);
    assert.equal(logouts.length, 1);
    assert.deepEqual(logouts[0]?.args, ["logout", registry]);
    // 出力を端末に流さない。stdin には何も渡さない。
    assert.equal(logouts[0]?.options.capture, true);
    assert.equal(logouts[0]?.options.stdin, undefined);
    assert.ok(
      fake.calls.findIndex(isDockerLogout) > fake.calls.findIndex(isPush),
    );
    assert.equal([...logs, ...printed].join("\n").includes(ecrPassword), false);
  });
});

test("release-api logs out of the registry when a step after the login fails", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const fake = createFakeRunner({
      handler: (call) =>
        isBuild(call) ? Promise.reject(new Error("build failed")) : undefined,
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner: fake.commandRunner }),
      /build failed/u,
    );

    assert.deepEqual(fake.calls.find(isDockerLogout)?.args, [
      "logout",
      registry,
    ]);
  });
});

test("release-api does not log out when docker login did not succeed", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const fake = createFakeRunner({
      handler: (call) =>
        isDockerLogin(call)
          ? Promise.reject(commandFailure({ stderr: "denied" }))
          : undefined,
    });
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner: fake.commandRunner }),
      /docker login/u,
    );

    assert.equal(fake.calls.some(isDockerLogout), false);
  });
});

test("release-api removes the verify container by its exact name when --rm did not", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const fake = createFakeRunner({
      handler: (call) =>
        isVerifyRun(call)
          ? Promise.reject(commandFailure({ stderr: "boom" }))
          : undefined,
    });
    fake.setContainerExists(true);
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner: fake.commandRunner }),
      /did not refuse/u,
    );

    assert.deepEqual(fake.calls.find(isContainerRemove)?.args, [
      "rm",
      "-f",
      verifyContainerName,
    ]);
  });
});

test("release-api removes the owned verify container and image when interrupted by SIGINT", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const signalTarget = new EventEmitter();
    const reemitted: NodeJS.Signals[] = [];
    const fake = createFakeRunner({
      handler: (call) => {
        if (!isVerifyRun(call)) return undefined;
        fake.setContainerExists(true);
        return new Promise(() => undefined);
      },
    });
    const { options, printed } = baseOptions(tfvarsPath);

    const running = runReleaseApi({
      ...options,
      commandRunner: fake.commandRunner,
      reemitSignal: (signal) => reemitted.push(signal),
      signalTarget,
    });
    await waitFor(() => fake.calls.some(isVerifyRun));
    signalTarget.emit("SIGINT");
    await running;

    assert.deepEqual(fake.terminated, ["SIGINT"]);
    assert.deepEqual(reemitted, ["SIGINT"]);
    assert.equal(fake.calls.some(isPush), false);
    assert.deepEqual(fake.calls.find(isContainerRemove)?.args, [
      "rm",
      "-f",
      verifyContainerName,
    ]);
    assert.deepEqual(fake.calls.find(isImageRemove)?.args, [
      "image",
      "rm",
      localReference,
    ]);
    assert.deepEqual(fake.calls.find(isDockerLogout)?.args, [
      "logout",
      registry,
    ]);
    assert.deepEqual(printed, []);
    assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  });
});

test("release-api refuses a pre-existing local image with the release tag and leaves it alone", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const fake = createFakeRunner();
    fake.setImageExists(true);
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({ ...options, commandRunner: fake.commandRunner }),
      {
        message: `A local image ${localReference} already exists. Remove it with docker image rm ${localReference} and retry.`,
      },
    );
    assert.equal(fake.calls.some(isBuild), false);
    assert.equal(fake.calls.some(isImageRemove), false);
  });
});

test("release-api rejects a repository URL that is not a private ECR repository before running anything", async () => {
  await withTfvars("", async (tfvarsPath) => {
    const { calls, commandRunner } = createFakeRunner();
    const { options } = baseOptions(tfvarsPath);

    await assert.rejects(
      runReleaseApi({
        ...options,
        argv: ["--repository-url", "docker.io/library/node"],
        commandRunner,
      }),
      /--repository-url must be the bootstrap output ecr_repository_url/u,
    );
    await assert.rejects(
      runReleaseApi({ ...options, argv: [], commandRunner }),
      /--repository-url/u,
    );
    assert.deepEqual(calls, []);
  });
});

test("release-api prints the reference without creating a missing tfvars file", async () => {
  await withTfvars(undefined, async (tfvarsPath) => {
    const { commandRunner } = createFakeRunner({ published: true });
    const { logs, options, printed } = baseOptions(tfvarsPath);

    await runReleaseApi({ ...options, commandRunner });

    assert.deepEqual(printed, [`api_image=${repositoryUrl}@${existingDigest}`]);
    await assert.rejects(readFile(tfvarsPath, "utf8"), { code: "ENOENT" });
    assert.ok(logs.some((message) => message.includes("was not found")));
  });
});

test("parseEcrRepositoryUrl splits the registry, region, and repository name", () => {
  assert.deepEqual(parseEcrRepositoryUrl(repositoryUrl), {
    registry,
    region: "ap-northeast-1",
    repositoryName: "hono-starter-kit-dev-api",
    repositoryUrl,
  });
  assert.throws(() =>
    parseEcrRepositoryUrl(`${repositoryUrl}:release-${commit}`),
  );
  assert.throws(() => parseEcrRepositoryUrl(`${repositoryUrl}@sha256:abc`));
});

test("replaceApiImageAssignment replaces the value and keeps alignment and comments", () => {
  const reference = `${repositoryUrl}@${pushedDigest}`;
  assert.equal(
    replaceApiImageAssignment(
      `project   = "x"\napi_image = "old" # pinned\nadot_image = "y"\n`,
      reference,
    ),
    `project   = "x"\napi_image = "${reference}" # pinned\nadot_image = "y"\n`,
  );
  assert.equal(
    replaceApiImageAssignment(`project = "x"`, reference),
    `project = "x"\napi_image = "${reference}"\n`,
  );
  assert.equal(
    replaceApiImageAssignment(
      `# api_image には固定 digest を指定する。\n`,
      reference,
    ),
    `# api_image には固定 digest を指定する。\napi_image = "${reference}"\n`,
  );
  assert.throws(
    () => replaceApiImageAssignment(`api_image = var.image\n`, reference),
    /api_image is not a single quoted string/u,
  );
  assert.throws(
    () =>
      replaceApiImageAssignment(
        `api_image = "a"\napi_image = "b"\n`,
        reference,
      ),
    /more than one api_image/u,
  );
});
