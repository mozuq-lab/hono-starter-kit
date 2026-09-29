import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import {
  createTerraformCommandRunner,
  parseTerraformInvocation,
  runTerraform,
} from "./terraform.ts";

type Options = {
  environment?: NodeJS.ProcessEnv | undefined;
  capture?: boolean | undefined;
  signal?: AbortSignal | undefined;
};
type Call = { command: string; args: readonly string[]; options: Options };

const fixture = async (t: test.TestContext) => {
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "terraform-cli-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const aws = path.join(directory, "aws");
  await fs.mkdir(aws);
  return {
    directory,
    environment: {
      TERRAFORM_SOURCE_DIR: path.join(directory, "source"),
      TERRAFORM_AWS_DIR: aws,
      TERRAFORM_CONTAINER_NAME: "terraform-cli-test-owned",
    },
  };
};

const recordingRunner = (
  execute: (call: Call) => Promise<string> = async () => "",
) => {
  const calls: Call[] = [];
  return {
    calls,
    async run(command: string, args: readonly string[], options: Options = {}) {
      const call = { command, args, options };
      calls.push(call);
      return execute(call);
    },
  };
};

const mountSource = (args: readonly string[], destination: string) => {
  const mount = args.find((argument) =>
    argument.includes(`target=${destination}`),
  );
  assert.ok(mount);
  const source = /(?:^|,)source=([^,]+)/u.exec(mount)?.[1];
  assert.ok(source);
  return source;
};

test("ネイティブの変更コマンド・保存 plan・ファイル引数をそのまま受け付ける", () => {
  for (const [command, ...args] of [
    ["apply", "saved.tfplan"],
    ["destroy", "-var-file=local.tfvars"],
    ["show", "-json", "saved.tfplan"],
    ["state", "list"],
    ["import", "aws_s3_bucket.example", "bucket-name"],
    ["plan", "-out=saved.tfplan", "-detailed-exitcode"],
    ["init", "-backend-config=backend.hcl"],
    ["fmt", "../bootstrap"],
  ]) {
    assert.ok(command);
    assert.deepEqual(
      parseTerraformInvocation(["--", "--root", "bootstrap", command, ...args]),
      {
        root: "bootstrap",
        command,
        args,
      },
    );
  }
});

test("未知の root と root/chdir の上書きは Docker 起動前に拒否する", () => {
  for (const argv of [
    [],
    ["--root"],
    ["--root", "../dev", "plan"],
    ["--root", "unknown", "plan"],
    ["--root", "dev", "--root", "bootstrap", "plan"],
    ["plan", "--root=bootstrap"],
    ["-chdir=other", "plan"],
    ["plan", "-chdir", "other"],
    ["plan", "-chdir=other"],
  ])
    assert.throws(() => parseTerraformInvocation(argv));
});

test("固定イメージを直接実行し８つの論理 root と source override を解決する", async (t) => {
  const { environment } = await fixture(t);
  const commandRunner = recordingRunner();
  for (const [root, containerPath] of [
    ["dev", "/workspace/infra/terraform/environments/dev"],
    ["bootstrap", "/workspace/infra/terraform/bootstrap"],
    ["module:network", "/workspace/infra/terraform/modules/network"],
    ["module:data", "/workspace/infra/terraform/modules/data"],
    ["module:ingress", "/workspace/infra/terraform/modules/ingress"],
    ["module:edge", "/workspace/infra/terraform/modules/edge"],
    ["module:identity", "/workspace/infra/terraform/modules/identity"],
    ["module:workload", "/workspace/infra/terraform/modules/workload"],
  ] as const) {
    await runTerraform({
      argv: ["--root", root, "plan", "-out=plan.tfplan"],
      environment,
      commandRunner,
    });
    const call = commandRunner.calls.at(-1)!;
    assert.equal(call.command, "docker");
    assert.deepEqual(call.args.slice(0, 2), ["run", "--rm"]);
    assert.equal(
      mountSource(call.args, "/workspace/infra/terraform"),
      environment.TERRAFORM_SOURCE_DIR,
    );
    assert.deepEqual(call.args.slice(-4), [
      "hashicorp/terraform:1.15.8@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963",
      `-chdir=${containerPath}`,
      "plan",
      "-out=plan.tfplan",
    ]);
    assert.ok(call.args.includes("--interactive"));
  }
  assert.equal(commandRunner.calls.length, 8);
});

for (const inputIsTTY of [false, true]) {
  test(`stdin の TTY=${inputIsTTY} でも変数入力・更新確認・IMDS を既定で無効にする`, async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: inputIsTTY,
    });
    t.after(() => {
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    });
    const { environment } = await fixture(t);
    const commandRunner = recordingRunner();
    await runTerraform({ argv: ["apply"], environment, commandRunner });
    const call = commandRunner.calls[0]!;
    const childEnvironment = call.options.environment!;
    assert.equal(childEnvironment.TF_INPUT, "0");
    assert.equal(childEnvironment.CHECKPOINT_DISABLE, "1");
    assert.equal(childEnvironment.AWS_EC2_METADATA_DISABLED, "true");
    for (const name of [
      "TF_INPUT",
      "CHECKPOINT_DISABLE",
      "AWS_EC2_METADATA_DISABLED",
    ])
      assert.ok(call.args.includes(name));
    assert.equal(call.args.includes("-auto-approve"), false);

    await runTerraform({
      argv: ["state", "pull"],
      environment,
      commandRunner,
      capture: true,
    });
    assert.equal(commandRunner.calls[1]!.options.environment?.TF_INPUT, "0");
  });
}

test("明示した入力・更新確認・IMDS の設定を上書きしない", async (t) => {
  const { environment } = await fixture(t);
  const commandRunner = recordingRunner();
  await runTerraform({
    argv: ["plan", "-input=false"],
    environment: {
      ...environment,
      TF_INPUT: "1",
      CHECKPOINT_DISABLE: "0",
      AWS_EC2_METADATA_DISABLED: "false",
    },
    commandRunner,
  });
  const call = commandRunner.calls[0]!;
  assert.equal(call.options.environment?.TF_INPUT, "1");
  assert.equal(call.options.environment?.CHECKPOINT_DISABLE, "0");
  assert.equal(call.options.environment?.AWS_EC2_METADATA_DISABLED, "false");
  assert.equal(call.args.at(-1), "-input=false");
});

test("明示 AWS fixture は環境 credentials より優先し readonly mount する", async (t) => {
  const { environment } = await fixture(t);
  const commandRunner = recordingRunner();
  await runTerraform({
    argv: ["apply", "saved.tfplan"],
    commandRunner,
    environment: {
      ...environment,
      AWS_ACCESS_KEY_ID: "synthetic-key",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      TERRAFORM_IMAGE: "owned-image:test",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "synthetic-container-token",
    },
  });
  const call = commandRunner.calls[0]!;
  assert.equal(
    mountSource(call.args, "/terraform/.aws"),
    environment.TERRAFORM_AWS_DIR,
  );
  assert.ok(
    call.args.some((arg) => arg.includes("target=/terraform/.aws,readonly")),
  );
  assert.equal(call.args.at(-4), "owned-image:test");
  assert.doesNotMatch(JSON.stringify(call), /synthetic-/u);
});

for (const status of [0, 2, 17]) {
  test(`環境 credentials は mode600 の一時 INI へ書き、終了 status ${status} の後に削除する`, async (t) => {
    const { environment } = await fixture(t);
    const withoutAwsDirectory: NodeJS.ProcessEnv = { ...environment };
    delete withoutAwsDirectory.TERRAFORM_AWS_DIR;
    let temporaryDirectory = "";
    const commandRunner = recordingRunner(async (call) => {
      if (call.args[0] !== "run") return "";
      temporaryDirectory = mountSource(call.args, "/terraform/.aws");
      const credentials = path.join(temporaryDirectory, "credentials");
      assert.equal((await fs.stat(credentials)).mode & 0o777, 0o600);
      assert.equal(
        await fs.readFile(credentials, "utf8"),
        "[default]\naws_access_key_id = synthetic-key\naws_secret_access_key = synthetic-secret\naws_session_token = synthetic-token\n",
      );
      assert.doesNotMatch(
        JSON.stringify(call),
        /synthetic-(?:key|secret|token)/u,
      );
      assert.equal(call.options.environment?.AWS_PROFILE, "default");
      if (status !== 0)
        throw Object.assign(new Error("Terraform failed"), {
          exitStatus: status,
        });
      return "";
    });
    const invocation = runTerraform({
      argv: ["plan"],
      commandRunner,
      environment: {
        ...withoutAwsDirectory,
        AWS_ACCESS_KEY_ID: "synthetic-key",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret",
        AWS_SESSION_TOKEN: "synthetic-token",
        AWS_PROFILE: "other",
        AWS_EXPIRATION: "2000-01-01T00:00:00Z",
      },
    });
    if (status === 0) await invocation;
    else
      await assert.rejects(
        invocation,
        (error: unknown) =>
          (error as { exitStatus: number }).exitStatus === status,
      );
    assert.ok(temporaryDirectory);
    await assert.rejects(fs.stat(temporaryDirectory), { code: "ENOENT" });
  });
}

test("不完全な credentials と INI 注入を値を表示せず拒否する", async (t) => {
  const { environment } = await fixture(t);
  const withoutAwsDirectory: NodeJS.ProcessEnv = { ...environment };
  delete withoutAwsDirectory.TERRAFORM_AWS_DIR;
  for (const credentials of [
    { AWS_ACCESS_KEY_ID: "synthetic-only" },
    {
      AWS_ACCESS_KEY_ID: "synthetic-key",
      AWS_SECRET_ACCESS_KEY: "synthetic\n[other]",
    },
  ]) {
    const commandRunner = recordingRunner();
    await assert.rejects(
      runTerraform({
        argv: ["plan"],
        environment: { ...withoutAwsDirectory, ...credentials },
        commandRunner,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic/u);
        return true;
      },
    );
    assert.equal(commandRunner.calls.length, 0);
  }
});

test("capture は state list の stdout を返し、中断時は所有 container と credentials を片付ける", async (t) => {
  const { environment } = await fixture(t);
  const successfulRunner = recordingRunner(
    async () => "module.example.aws_s3_bucket.test\n",
  );
  assert.equal(
    await runTerraform({
      argv: ["state", "list"],
      environment,
      commandRunner: successfulRunner,
      capture: true,
    }),
    "module.example.aws_s3_bucket.test\n",
  );
  assert.equal(successfulRunner.calls[0]!.options.capture, true);
  assert.equal(successfulRunner.calls[0]!.args.includes("--tty"), false);

  const controller = new AbortController();
  const withoutAwsDirectory: NodeJS.ProcessEnv = { ...environment };
  delete withoutAwsDirectory.TERRAFORM_AWS_DIR;
  let temporaryDirectory = "";
  const commandRunner = recordingRunner(async (call) => {
    if (call.args[0] !== "run") return "terraform-cli-test-owned\n";
    temporaryDirectory = mountSource(call.args, "/terraform/.aws");
    controller.abort("SIGTERM");
    assert.equal(call.options.signal?.aborted, true);
    throw Object.assign(new Error("interrupted"), { exitStatus: 143 });
  });
  await assert.rejects(
    runTerraform({
      argv: ["apply"],
      commandRunner,
      signal: controller.signal,
      environment: {
        ...withoutAwsDirectory,
        AWS_ACCESS_KEY_ID: "synthetic-key",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      },
    }),
    { exitStatus: 143 },
  );
  assert.deepEqual(commandRunner.calls[2]!.args, [
    "rm",
    "--force",
    "terraform-cli-test-owned",
  ]);
  assert.equal(commandRunner.calls[2]!.options.signal?.aborted, undefined);
  await assert.rejects(fs.stat(temporaryDirectory), { code: "ENOENT" });
});

test("実 subprocess runner は stdout と native exit code を保ち捕捉出力を Error に付加しない", async () => {
  const runner = createTerraformCommandRunner();
  assert.equal(
    await runner.run(
      process.execPath,
      ["-e", "process.stdout.write('state-result')"],
      { capture: true },
    ),
    "state-result",
  );
  await assert.rejects(
    runner.run(
      process.execPath,
      [
        "-e",
        "process.stdout.write('synthetic-secret');process.stderr.write('synthetic-secret');process.exit(2)",
      ],
      { capture: true },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { exitStatus: number }).exitStatus, 2);
      assert.doesNotMatch(
        String(error) + JSON.stringify(error),
        /synthetic-secret/u,
      );
      return true;
    },
  );
});

test("実 CLI が native exit code を維持し fake Docker への credentials 展開を防ぐ", async (t) => {
  const { directory, environment } = await fixture(t);
  const fakeDocker = path.join(directory, "docker");
  await fs.writeFile(
    fakeDocker,
    `#!${process.execPath}\nif (process.argv[2] === 'run') { if (process.env.AWS_SECRET_ACCESS_KEY) process.exit(99); process.exit(2); }\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      new URL("./terraform.ts", import.meta.url).pathname,
      "--",
      "plan",
      "-out=saved.tfplan",
    ],
    {
      env: {
        PATH: directory,
        ...environment,
        AWS_ACCESS_KEY_ID: "synthetic-key",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /synthetic/u);
});

test("state pull の失敗は秘密を出さず対象と再確認コマンドを端末に伝える", async (t) => {
  const { directory, environment } = await fixture(t);
  await fs.writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}\nif (process.argv[2] === 'run') { process.stdout.write('synthetic-state-secret'); process.stderr.write('synthetic-credential-secret'); process.exit(17); }\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      new URL("./terraform-teardown.ts", import.meta.url).pathname,
      "--root",
      "bootstrap",
      "destroy",
    ],
    { env: { PATH: directory, ...environment }, encoding: "utf8" },
  );
  assert.equal(result.status, 17);
  assert.match(result.stderr, /dev.*state/u);
  assert.match(result.stderr, /backend initialization.*AWS/u);
  assert.match(result.stderr, /pnpm terraform -- --root dev state list/u);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(?:state|credential)-secret/u,
  );
});

test("共有 AWS ディレクトリは HOME から解決し readonly mount する", async (t) => {
  const { directory, environment } = await fixture(t);
  const awsDirectory = path.join(directory, ".aws");
  await fs.mkdir(awsDirectory);
  await fs.writeFile(
    path.join(awsDirectory, "config"),
    "[profile fixture]\nregion = us-east-1\n",
  );
  const withoutAwsDirectory: NodeJS.ProcessEnv = {
    ...environment,
    HOME: directory,
    AWS_PROFILE: "fixture",
  };
  delete withoutAwsDirectory.TERRAFORM_AWS_DIR;
  const commandRunner = recordingRunner();
  await runTerraform({
    argv: ["version"],
    environment: withoutAwsDirectory,
    commandRunner,
  });
  const call = commandRunner.calls[0]!;
  assert.equal(mountSource(call.args, "/terraform/.aws"), awsDirectory);
  assert.ok(
    call.args.some((arg) => arg.includes("target=/terraform/.aws,readonly")),
  );
  assert.equal(call.options.environment?.AWS_PROFILE, "fixture");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`実 CLI の ${signal} が子へ届き終了前に owned container と credentials を削除する`, async (t) => {
    const { directory, environment } = await fixture(t);
    const marker = path.join(directory, "started.json");
    const received = path.join(directory, "received-signal");
    const cleanup = path.join(directory, "cleanup.json");
    await fs.writeFile(
      path.join(directory, "docker"),
      `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'run') {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { fs.writeFileSync(process.env.RECEIVED, signal); process.exit(0); });
  fs.writeFileSync(process.env.MARKER, JSON.stringify(process.argv.slice(2)));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'container') { process.stdout.write('terraform-cli-test-owned\\n'); } else { fs.writeFileSync(process.env.CLEANUP, JSON.stringify(process.argv.slice(2))); }
`,
      { mode: 0o755 },
    );
    const childEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      PATH: directory,
      AWS_ACCESS_KEY_ID: "synthetic-key",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      MARKER: marker,
      RECEIVED: received,
      CLEANUP: cleanup,
    };
    delete childEnvironment.TERRAFORM_AWS_DIR;
    const child = spawn(
      process.execPath,
      [new URL("./terraform.ts", import.meta.url).pathname, "apply"],
      { env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    let args: string[] | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        args = JSON.parse(await fs.readFile(marker, "utf8")) as string[];
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await setTimeout(10);
    }
    assert.ok(args, stderr);
    const awsDirectory = mountSource(args, "/terraform/.aws");
    child.kill(signal);
    assert.equal(await closed, signal === "SIGINT" ? 130 : 143, stderr);
    assert.equal(await fs.readFile(received, "utf8"), signal);
    assert.deepEqual(JSON.parse(await fs.readFile(cleanup, "utf8")), [
      "rm",
      "--force",
      "terraform-cli-test-owned",
    ]);
    await assert.rejects(fs.stat(awsDirectory), { code: "ENOENT" });
    assert.doesNotMatch(stderr, /synthetic/u);
  });
}

test("同名の既存 container は run ごとの所有 label が一致しなければ削除しない", async (t) => {
  const { environment } = await fixture(t);
  const commandRunner = recordingRunner(async (call) => {
    if (call.args[0] === "run")
      throw Object.assign(new Error("name collision"), { exitStatus: 125 });
    return "";
  });
  await assert.rejects(
    runTerraform({ argv: ["version"], environment, commandRunner }),
    { exitStatus: 125 },
  );
  assert.equal(
    commandRunner.calls.some((call) => call.args[0] === "rm"),
    false,
  );
  const run = commandRunner.calls[0]!;
  const label = run.args[run.args.indexOf("--label") + 1];
  assert.match(label ?? "", /^hono-starter\.terraform\.owner=[a-z0-9-]+$/u);
  const lookup = commandRunner.calls[1]!;
  assert.ok(lookup.args.includes(`label=${label}`));
});

for (const brokenStep of ["lookup", "remove"]) {
  test(`所有 container の ${brokenStep} 失敗を黙殺せず native exit code と共に知らせる`, async (t) => {
    const { environment } = await fixture(t);
    const operationFailure = Object.assign(new Error("Terraform failed"), {
      exitStatus: 2,
    });
    const commandRunner = recordingRunner(async (call) => {
      if (call.args[0] === "run") throw operationFailure;
      if (
        (brokenStep === "lookup" && call.args[0] === "container") ||
        call.args[0] === "rm"
      )
        throw Object.assign(new Error("daemon unavailable"), { exitStatus: 1 });
      return `${environment.TERRAFORM_CONTAINER_NAME}\n`;
    });
    await assert.rejects(
      runTerraform({ argv: ["plan"], environment, commandRunner }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cleanup/u);
        assert.match(error.message, /Terraform failed/u);
        assert.equal(error.cause, operationFailure);
        assert.equal((error as Error & { exitStatus: number }).exitStatus, 2);
        return true;
      },
    );
  });
}

test("指定 ownership token を run の label と cleanup の照合に引き継ぐ", async (t) => {
  const { environment } = await fixture(t);
  const commandRunner = recordingRunner(async (call) => {
    if (call.args[0] === "run")
      throw Object.assign(new Error("Terraform failed"), { exitStatus: 2 });
    return "";
  });
  await assert.rejects(
    runTerraform({
      argv: ["plan"],
      environment: {
        ...environment,
        TERRAFORM_CONTAINER_OWNER: "fixture-owner",
      },
      commandRunner,
    }),
    { exitStatus: 2 },
  );
  assert.ok(
    commandRunner.calls[0]!.args.includes(
      "hono-starter.terraform.owner=fixture-owner",
    ),
  );
  assert.ok(
    commandRunner.calls[1]!.args.includes(
      "label=hono-starter.terraform.owner=fixture-owner",
    ),
  );
});
