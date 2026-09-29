import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runTerraform } from "./terraform.ts";

const releaseVariables = {
  bootstrap: ["ecr_force_delete=true", "state_bucket_force_destroy=true"],
  dev: [
    "alb_deletion_protection=false",
    "database_deletion_protection=false",
    "database_skip_final_snapshot=true",
    "identity_deletion_protection=false",
    "web_bucket_force_destroy=true",
  ],
};

export const runTerraformTeardown = async ({
  argv = process.argv.slice(2),
  terraform = runTerraform,
}: {
  argv?: readonly string[];
  terraform?: typeof runTerraform;
} = {}) => {
  const invocation = argv[0] === "--" ? argv.slice(1) : argv;
  const [flag, root, operation] = invocation;
  if (
    invocation.length !== 3 ||
    flag !== "--root" ||
    (root !== "bootstrap" && root !== "dev") ||
    (operation !== "unprotect" && operation !== "destroy")
  ) {
    throw new Error("Usage: --root <bootstrap|dev> <unprotect|destroy>");
  }

  // dev の state 保存先を先に失うと、残るリソースを Terraform で追跡できなくなる。
  if (root === "bootstrap") {
    // state list は未作成でも失敗する。pull は local では空文字、S3 では空 state を返す。
    const stateText = await terraform({
      argv: ["--root", "dev", "state", "pull"],
      capture: true,
    });
    let state: unknown;
    try {
      state =
        stateText.trim() === "" ? { resources: [] } : JSON.parse(stateText);
    } catch {
      throw new Error("Invalid dev Terraform state.");
    }
    if (
      typeof state !== "object" ||
      state === null ||
      !("resources" in state) ||
      !Array.isArray(state.resources)
    ) {
      throw new Error("Invalid dev Terraform state.");
    }
    if (state.resources.length !== 0) {
      throw new Error(
        "Destroy the dev environment before the bootstrap foundation.",
      );
    }
  }

  await terraform({
    argv: [
      "--root",
      root,
      ...(operation === "unprotect"
        ? [
            "apply",
            ...releaseVariables[root].map((variable) => `-var=${variable}`),
          ]
        : ["destroy"]),
    ],
  });
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runTerraformTeardown();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Terraform teardown failed.",
    );
    process.exitCode =
      error instanceof Error &&
      "exitStatus" in error &&
      typeof error.exitStatus === "number"
        ? error.exitStatus
        : 1;
  }
}
