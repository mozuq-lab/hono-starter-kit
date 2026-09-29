import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runTerraformChecks } from "./terraform-checks.ts";

const roots = [
  "/workspace/infra/terraform/bootstrap",
  "/workspace/infra/terraform/modules/network",
  "/workspace/infra/terraform/modules/data",
  "/workspace/infra/terraform/modules/ingress",
  "/workspace/infra/terraform/modules/edge",
  "/workspace/infra/terraform/modules/identity",
  "/workspace/infra/terraform/modules/workload",
  "/workspace/infra/terraform/environments/dev",
];

const fixture = async (t: test.TestContext) => {
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "terraform-checks-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    TERRAFORM_AWS_DIR: directory,
    TERRAFORM_SOURCE_DIR: directory,
    TERRAFORM_CONTAINER_NAME: "terraform-checks-test-owned",
  };
};

for (const [mode, phases] of [
  ["fmt", [["fmt", "-check", "-recursive"]]],
  [
    "validate",
    [["init", "-backend=false", "-lockfile=readonly"], ["validate"]],
  ],
  ["test", [["init", "-backend=false", "-lockfile=readonly"], ["test"]]],
  [
    "check",
    [
      ["fmt", "-check", "-recursive"],
      ["init", "-backend=false", "-lockfile=readonly"],
      ["validate"],
      ["test"],
    ],
  ],
] as const) {
  test(`${mode} は８ root を wrapper で順に検証し fmt は書き換えず init は各 root 一度だけ行う`, async (t) => {
    const environment = await fixture(t);
    const calls: string[][] = [];
    const commandRunner = {
      async run(command: string, args: readonly string[]) {
        assert.equal(command, "docker");
        assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
        calls.push(
          args.slice(args.findIndex((arg) => arg.startsWith("-chdir="))),
        );
        return "";
      },
    };
    await runTerraformChecks(mode, { environment, commandRunner });
    assert.deepEqual(
      calls,
      roots.flatMap((root) =>
        phases.map((phase) => [`-chdir=${root}`, ...phase]),
      ),
    );
  });
}

test("失敗後は次の root を始めず native exit code を保つ", async (t) => {
  const environment = await fixture(t);
  let runCalls = 0;
  const commandRunner = {
    async run(_command: string, args: readonly string[]) {
      if (args[0] === "run" && ++runCalls === 2)
        throw Object.assign(new Error("failed"), { exitStatus: 23 });
      return "";
    },
  };
  await assert.rejects(
    runTerraformChecks("validate", { environment, commandRunner }),
    { exitStatus: 23 },
  );
  assert.equal(runCalls, 2);
});

test("中断された子が成功を返しても以降の phase を始めない", async (t) => {
  const environment = await fixture(t);
  const controller = new AbortController();
  let runCalls = 0;
  const commandRunner = {
    async run(_command: string, args: readonly string[]) {
      if (args[0] === "run") {
        runCalls += 1;
        controller.abort("SIGINT");
      }
      return "";
    },
  };
  await assert.rejects(
    runTerraformChecks("check", {
      environment,
      commandRunner,
      signal: controller.signal,
    }),
    { exitStatus: 130 },
  );
  assert.equal(runCalls, 1);
});

test("集約モードを間違えても Docker を起動しない", async () => {
  for (const mode of [undefined, "", "apply", "destroy", "plan"]) {
    let called = false;
    await assert.rejects(
      runTerraformChecks(mode, {
        commandRunner: {
          async run() {
            called = true;
            return "";
          },
        },
      }),
    );
    assert.equal(called, false);
  }
});
