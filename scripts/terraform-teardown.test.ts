import assert from "node:assert/strict";
import test from "node:test";

import { runTerraformTeardown } from "./terraform-teardown.ts";

test("dev の削除は Terraform 本来の確認付き destroy に渡す", async () => {
  const calls: string[][] = [];
  await runTerraformTeardown({
    argv: ["--root", "dev", "destroy"],
    terraform: async ({ argv }: { argv: readonly string[] }) => {
      calls.push([...argv]);
      return "";
    },
  });
  assert.deepEqual(calls, [["--root", "dev", "destroy"]]);
});

test("bootstrap は dev の state が空になってから削除する", async () => {
  const calls: { argv: readonly string[]; capture?: boolean | undefined }[] =
    [];
  await runTerraformTeardown({
    argv: ["--", "--root", "bootstrap", "destroy"],
    terraform: async (options) => {
      calls.push(options);
      return JSON.stringify({ version: 4, resources: [] });
    },
  });
  assert.deepEqual(
    calls.map(({ argv }) => argv),
    [
      ["--root", "dev", "state", "pull"],
      ["--root", "bootstrap", "destroy"],
    ],
  );
  assert.equal(calls[0]?.capture, true);
});

for (const operation of ["unprotect", "destroy"]) {
  for (const [backend, state] of [
    ["local", ""],
    [
      "S3",
      JSON.stringify({ version: 4, serial: 0, outputs: {}, resources: [] }),
    ],
  ]) {
    test(`dev の ${backend} state が未作成でも bootstrap の ${operation} に進む`, async () => {
      const calls: string[][] = [];
      await runTerraformTeardown({
        argv: ["--root", "bootstrap", operation],
        terraform: async ({ argv }) => {
          calls.push([...argv]);
          if (argv[1] === "dev") {
            if (argv.at(-1) === "list") {
              throw Object.assign(new Error("No state file was found!"), {
                exitStatus: 1,
              });
            }
            return state!;
          }
          return "";
        },
      });
      assert.deepEqual(calls[0], ["--root", "dev", "state", "pull"]);
      assert.deepEqual(calls[1]?.slice(0, 3), [
        "--root",
        "bootstrap",
        operation === "unprotect" ? "apply" : "destroy",
      ]);
      assert.equal(calls.length, 2);
    });
  }

  test(`dev が残っていると bootstrap の ${operation} を拒否する`, async () => {
    const calls: string[][] = [];
    await assert.rejects(
      runTerraformTeardown({
        argv: ["--root", "bootstrap", operation],
        terraform: async ({ argv }) => {
          calls.push([...argv]);
          return JSON.stringify({
            version: 4,
            resources: [
              {
                mode: "managed",
                type: "aws_db_instance",
                name: "postgres",
                instances: [{ attributes: { password: "synthetic-secret" } }],
              },
            ],
          });
        },
      }),
      /dev/u,
    );
    assert.deepEqual(calls, [["--root", "dev", "state", "pull"]]);
  });

  test(`dev の state を取得できなければ bootstrap の ${operation} へ進まない`, async () => {
    const calls: string[][] = [];
    const failure = Object.assign(
      new Error("Backend initialization required"),
      {
        exitStatus: 1,
      },
    );
    await assert.rejects(
      runTerraformTeardown({
        argv: ["--root", "bootstrap", operation],
        terraform: async ({ argv }) => {
          calls.push([...argv]);
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(calls.length, 1);
  });

  test(`dev state の不正な応答では内容を表示せず bootstrap の ${operation} を拒否する`, async () => {
    for (const state of [
      '{"synthetic-secret":',
      "null",
      "[]",
      "{}",
      '{"resources":null}',
      '{"resources":{}}',
    ]) {
      let calls = 0;
      await assert.rejects(
        runTerraformTeardown({
          argv: ["--root", "bootstrap", operation],
          terraform: async () => {
            calls++;
            return state;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /dev.*state/u);
          assert.doesNotMatch(error.message, /synthetic-secret/u);
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  });
}

test("dev の保護解除は必要な変数だけを確認付き apply に渡す", async () => {
  const calls: string[][] = [];
  await runTerraformTeardown({
    argv: ["--root", "dev", "unprotect"],
    terraform: async ({ argv }) => {
      calls.push([...argv]);
      return "";
    },
  });
  assert.deepEqual(calls, [
    [
      "--root",
      "dev",
      "apply",
      "-var=alb_deletion_protection=false",
      "-var=database_deletion_protection=false",
      "-var=database_skip_final_snapshot=true",
      "-var=identity_deletion_protection=false",
      "-var=web_bucket_force_destroy=true",
    ],
  ]);
});

test("bootstrap の保護解除も state 確認後に限定した変数を渡す", async () => {
  const calls: string[][] = [];
  await runTerraformTeardown({
    argv: ["--root", "bootstrap", "unprotect"],
    terraform: async ({ argv }) => {
      calls.push([...argv]);
      return "";
    },
  });
  assert.deepEqual(calls[1], [
    "--root",
    "bootstrap",
    "apply",
    "-var=ecr_force_delete=true",
    "-var=state_bucket_force_destroy=true",
  ]);
});

test("不正な root や確認を飛ばす追加引数では何も実行しない", async () => {
  for (const argv of [
    [],
    ["destroy"],
    ["--root", "../dev", "destroy"],
    ["--root", "module:data", "destroy"],
    ["--root", "dev", "apply"],
    ["--root", "dev", "destroy", "-auto-approve"],
  ]) {
    let called = false;
    await assert.rejects(
      runTerraformTeardown({
        argv,
        terraform: async () => {
          called = true;
          return "";
        },
      }),
    );
    assert.equal(called, false);
  }
});
