import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { createTerraformDockerVerification } from "./terraform-verification.ts";

const projectName = "hono-starter-kit-terraform-test-native";
const imageName = `${projectName}-image:verify`;
const containerName = `${projectName}-container`;
const pinnedImage =
  "hashicorp/terraform:1.15.8@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963";
const pinnedReference =
  "hashicorp/terraform@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963";
const roots = [
  "bootstrap",
  "module:network",
  "module:data",
  "module:ingress",
  "module:edge",
  "module:identity",
  "module:workload",
  "dev",
];
const sourceFiles = [
  "bootstrap/main.tf",
  "bootstrap/.terraform.lock.hcl",
  "bootstrap/tests/bootstrap.tftest.hcl",
  "modules/edge/function.js",
  "modules/edge/tests/function.test.mjs",
];
const excludedFiles = [
  "bootstrap/backend.hcl",
  "bootstrap/terraform.tfvars",
  "bootstrap/state.tfstate",
  "bootstrap/plan.tfplan",
  "bootstrap/.terraform/provider.js",
  ".deploy/manifest.js",
  "bootstrap/secret.pem",
];

type Call = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
};

const fixture = async (
  t: test.TestContext,
  {
    cachedImage = true,
    version = "Terraform v1.15.8\non linux_arm64",
    failurePhase,
    residue = false,
    environment = {},
  }: {
    cachedImage?: boolean;
    version?: string;
    failurePhase?: string;
    residue?: boolean;
    environment?: NodeJS.ProcessEnv;
  } = {},
) => {
  const repositoryRoot = await fs.mkdtemp(
    path.join(tmpdir(), "terraform-acceptance-fixture-"),
  );
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  for (const file of [
    ...sourceFiles,
    ...excludedFiles,
    "bootstrap/untracked.tf",
  ]) {
    const target = path.join(repositoryRoot, "infra/terraform", file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `synthetic fixture ${file}`);
  }
  const calls: Call[] = [];
  const images = new Set(cachedImage ? [pinnedImage] : []);
  const containers = new Set<string>();
  const foreignContainers = new Set<string>();
  const failure = new Error("synthetic Terraform failure");
  let onInvocation: ((call: Call) => Promise<void> | void) | undefined;
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      const call = { command, args, options };
      calls.push(call);
      if (command === "git") {
        assert.deepEqual(args, [
          "-C",
          repositoryRoot,
          "ls-files",
          "-z",
          "--",
          "infra/terraform",
        ]);
        return [...sourceFiles, ...excludedFiles]
          .map((name) => `infra/terraform/${name}`)
          .join("\0");
      }
      if (command === "pnpm") {
        await onInvocation?.(call);
        if (args.includes(failurePhase ?? "(none)")) {
          containers.add(containerName);
          throw failure;
        }
        return args.includes("version") ? version : "Success!";
      }
      if (command === process.execPath) {
        assert.deepEqual(args, [
          "--test",
          path.join(
            repositoryRoot,
            "scripts/terraform-foundation-plan.acceptance.ts",
          ),
        ]);
        if (failurePhase === "consumer") throw failure;
        return "consumer tests passed";
      }
      assert.equal(command, "docker");
      if (args[0] === "container" && args[1] === "ls") {
        assert.ok(args.includes(`name=^/${containerName}$`));
        const ownerFilter = args.find((argument) =>
          argument.startsWith("label="),
        );
        if (ownerFilter !== undefined) {
          const owner = (options.environment as NodeJS.ProcessEnv)
            .TERRAFORM_CONTAINER_OWNER;
          assert.ok(owner);
          assert.equal(
            ownerFilter,
            `label=hono-starter.terraform.owner=${owner}`,
          );
          return containers.has(containerName) ? "owned-container-id" : "";
        }
        return containers.has(containerName) ||
          foreignContainers.has(containerName)
          ? "container-id"
          : "";
      }
      if (args[0] === "image" && args[1] === "ls") {
        if (args.includes("--digests"))
          return images.has(pinnedImage) ? pinnedReference : "";
        assert.equal(args.at(-1), `reference=${imageName}`);
        return images.has(imageName) ? "owned-image-id" : "";
      }
      if (args[0] === "pull") {
        assert.equal(args[1], pinnedImage);
        images.add(pinnedImage);
        return "pulled";
      }
      if (args[0] === "tag") {
        assert.deepEqual(args, ["tag", pinnedImage, imageName]);
        images.add(imageName);
        return "";
      }
      if (args[0] === "container" && args[1] === "rm") {
        assert.deepEqual(args, ["container", "rm", "--force", containerName]);
        containers.delete(containerName);
        foreignContainers.delete(containerName);
        return "";
      }
      if (args[0] === "image" && args[1] === "rm") {
        assert.ok([imageName, pinnedImage].includes(args[2] ?? ""));
        if (!residue) images.delete(args[2] ?? "");
        return "";
      }
      assert.fail(`Unexpected Docker command: ${args.join(" ")}`);
    },
  };
  const verifier = createTerraformDockerVerification({
    commandRunner,
    repositoryRoot,
    projectName,
    environment: {
      PATH: "/synthetic/bin",
      AWS_PROFILE: "real-profile",
      AWS_ACCESS_KEY_ID: "synthetic-secret",
      TF_CLI_ARGS: "-target=unexpected",
      TERRAFORM_SOURCE_DIR: "/do-not-use",
      ...environment,
    },
    log: () => undefined,
  });
  t.after(() => verifier.cleanup().catch(() => undefined));
  return {
    calls,
    images,
    containers,
    foreignContainers,
    failure,
    verifier,
    repositoryRoot,
    commandRunner,
    setOnInvocation(callback: typeof onInvocation) {
      onInvocation = callback;
    },
  };
};

const wrapperEnvironment = (calls: Call[]) =>
  calls.find(({ command }) => command === "pnpm")?.options
    .environment as NodeJS.ProcessEnv;
const assertTemporaryPathsRemoved = async (environment: NodeJS.ProcessEnv) => {
  for (const name of ["TERRAFORM_SOURCE_DIR", "TERRAFORM_AWS_DIR"]) {
    await assert.rejects(fs.stat(environment[name] ?? ""), { code: "ENOENT" });
  }
};

test("公開 CLI で 8 root の init・validate・native test を実行し、所有リソースを片付ける", async (t) => {
  const f = await fixture(t);
  await f.verifier.verify();
  const invocations = f.calls
    .filter(({ command }) => command === "pnpm")
    .map(({ args }) => args);
  assert.deepEqual(invocations[0], [
    "terraform",
    "--",
    "--root",
    "bootstrap",
    "version",
  ]);
  assert.equal(invocations.length, 25);
  for (const root of roots) {
    assert.deepEqual(
      invocations.slice(1).filter((args) => args[3] === root),
      [
        [
          "terraform",
          "--",
          "--root",
          root,
          "init",
          "-backend=false",
          "-lockfile=readonly",
        ],
        ["terraform", "--", "--root", root, "validate"],
        ["terraform", "--", "--root", root, "test"],
      ],
    );
  }
  assert.deepEqual(
    f.calls
      .filter(({ command }) => command === process.execPath)
      .map(({ args }) => args),
    [
      [
        "--test",
        path.join(
          f.repositoryRoot,
          "scripts/terraform-foundation-plan.acceptance.ts",
        ),
      ],
    ],
  );
  assert.equal(f.images.has(imageName), true);
  await f.verifier.cleanup();
  await f.verifier.cleanup();
  assert.deepEqual([...f.images], [pinnedImage]);
  assert.equal(f.containers.size, 0);
  await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
});

test("tracked source・lock・test だけを隔離し、空 AWS directory と環境を渡す", async (t) => {
  const f = await fixture(t);
  f.setOnInvocation(async ({ options }) => {
    const environment = options.environment as NodeJS.ProcessEnv;
    const sourceDirectory = environment.TERRAFORM_SOURCE_DIR ?? "";
    for (const file of sourceFiles) {
      assert.equal(
        await fs.readFile(path.join(sourceDirectory, file), "utf8"),
        `synthetic fixture ${file}`,
      );
    }
    for (const file of [...excludedFiles, "bootstrap/untracked.tf"]) {
      await assert.rejects(fs.stat(path.join(sourceDirectory, file)), {
        code: "ENOENT",
      });
    }
    assert.deepEqual(await fs.readdir(environment.TERRAFORM_AWS_DIR ?? ""), []);
    assert.equal(environment.TERRAFORM_IMAGE, imageName);
    assert.equal(environment.TERRAFORM_CONTAINER_NAME, containerName);
    assert.equal(environment.AWS_PROFILE, undefined);
    assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(environment.TF_CLI_ARGS, undefined);
    assert.equal(environment.AWS_EC2_METADATA_DISABLED, "true");
  });
  await f.verifier.verify();
  assert.equal(
    await fs.readFile(
      path.join(f.repositoryRoot, "infra/terraform/bootstrap/main.tf"),
      "utf8",
    ),
    "synthetic fixture bootstrap/main.tf",
  );
});

for (const phase of ["init", "validate", "test"]) {
  test(`${phase} の失敗を保持し、残った所有 container と temp を削除する`, async (t) => {
    const f = await fixture(t, { failurePhase: phase });
    await assert.rejects(f.verifier.verify(), (error) => error === f.failure);
    assert.equal(f.containers.size, 0);
    assert.equal(f.images.has(imageName), false);
    await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
    assert.equal(f.calls.filter(({ args }) => args.includes(phase)).length, 1);
  });
}

test("中断後は次の Terraform を起動せず、abort 済み signal を cleanup に渡さない", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const verifier = createTerraformDockerVerification({
    commandRunner: f.commandRunner,
    repositoryRoot: f.repositoryRoot,
    projectName,
    environment: {},
    signal: controller.signal,
  });
  f.setOnInvocation(() => {
    f.containers.add(containerName);
    controller.abort();
  });
  await assert.rejects(verifier.verify(), { name: "AbortError" });
  assert.equal(f.calls.filter(({ command }) => command === "pnpm").length, 1);
  assert.equal(f.containers.size, 0);
  assert.equal(f.images.has(imageName), false);
  for (const call of f.calls.filter(({ args }) => args[1] === "rm"))
    assert.equal(call.options.signal, undefined);
  await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
});

test("新規 pull した固定 image は cleanup し、既存 cache は保持する", async (t) => {
  const f = await fixture(t, { cachedImage: false });
  await f.verifier.verify();
  assert.deepEqual(
    f.calls.filter(({ args }) => args[0] === "pull").map(({ args }) => args),
    [["pull", pinnedImage]],
  );
  await f.verifier.cleanup();
  assert.equal(f.images.size, 0);
});

test("異なる Terraform version は検証失敗にし、init へ進まない", async (t) => {
  const f = await fixture(t, { version: "Terraform v0.14.0" });
  await assert.rejects(f.verifier.verify(), /Terraform v1\.15\.8/u);
  assert.equal(
    f.calls.some(({ args }) => args.includes("init")),
    false,
  );
  assert.equal(f.images.has(imageName), false);
});

test("削除後の image residue を報告しても temp directory は片付ける", async (t) => {
  const f = await fixture(t, { residue: true });
  await f.verifier.verify();
  await assert.rejects(f.verifier.cleanup(), /cleanup/u);
  await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
});

test("既存の同名リソースは削除せずに停止する", async (t) => {
  const f = await fixture(t);
  f.images.add(imageName);
  await assert.rejects(f.verifier.verify(), /already exists/u);
  assert.equal(f.images.has(imageName), true);
  assert.equal(
    f.calls.some(({ args }) => args[1] === "rm"),
    false,
  );
});

test("foundation plan の consumer 検査の失敗も検証失敗として扱う", async (t) => {
  const f = await fixture(t, { failurePhase: "consumer" });
  await assert.rejects(f.verifier.verify(), (error) => error === f.failure);
  assert.equal(f.images.has(imageName), false);
  await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
});

test("事前確認後に現れた同名の別 owner container は cleanup で削除しない", async (t) => {
  const f = await fixture(t);
  f.setOnInvocation(() => {
    f.foreignContainers.add(containerName);
    throw f.failure;
  });
  await assert.rejects(f.verifier.verify(), (error) => error === f.failure);
  assert.equal(f.foreignContainers.has(containerName), true);
  assert.equal(
    f.calls.some(({ args }) => args[0] === "container" && args[1] === "rm"),
    false,
  );
  await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
});

for (const outcome of ["success", "failure"] as const) {
  test(`Docker の接続・TLS設定を引き継ぎ ${outcome} 後も caller の設定を削除しない`, async (t) => {
    const callerConfig = await fs.mkdtemp(
      path.join(tmpdir(), "terraform-caller-docker-"),
    );
    t.after(() => fs.rm(callerConfig, { recursive: true, force: true }));
    const config = JSON.stringify({
      currentContext: "fixture-context",
      auths: { "registry.example.test": {} },
    });
    await fs.writeFile(path.join(callerConfig, "config.json"), config);
    const dockerEnvironment = {
      DOCKER_CONFIG: callerConfig,
      DOCKER_CONTEXT: "fixture-context",
      DOCKER_HOST: "tcp://127.0.0.1:12345",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: path.join(callerConfig, "tls"),
    };
    const f = await fixture(t, {
      environment: dockerEnvironment,
      ...(outcome === "failure" ? { failurePhase: "test" } : {}),
    });
    if (outcome === "failure")
      await assert.rejects(f.verifier.verify(), (error) => error === f.failure);
    else await f.verifier.verify();
    await f.verifier.cleanup();
    for (const call of f.calls) {
      const environment = call.options.environment as NodeJS.ProcessEnv;
      for (const [name, value] of Object.entries(dockerEnvironment))
        assert.equal(environment[name], value);
    }
    assert.equal(
      await fs.readFile(path.join(callerConfig, "config.json"), "utf8"),
      config,
    );
    await assertTemporaryPathsRemoved(wrapperEnvironment(f.calls));
  });
}

test("DOCKER_CONFIG 未指定時は Docker 標準の設定解決を上書きしない", async (t) => {
  const f = await fixture(t);
  await f.verifier.verify();
  await f.verifier.cleanup();
  assert.equal(wrapperEnvironment(f.calls).DOCKER_CONFIG, undefined);
});
