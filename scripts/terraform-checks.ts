import process from "node:process";
import { pathToFileURL } from "node:url";

import { runTerraform, reportTerraformFailure } from "./terraform.ts";

export const FOUNDATION_ROOTS = Object.freeze([
  "bootstrap",
  "module:network",
  "module:data",
  "module:ingress",
  "module:edge",
  "module:identity",
  "module:workload",
  "dev",
]);

export const runTerraformChecks = async (
  mode: unknown,
  options: Omit<Parameters<typeof runTerraform>[0], "argv" | "capture"> = {},
) => {
  if (
    mode !== "fmt" &&
    mode !== "validate" &&
    mode !== "test" &&
    mode !== "check"
  ) {
    throw new Error("Allowed aggregate modes: fmt, validate, test, check");
  }
  const phases: string[][] = [];
  if (mode === "fmt" || mode === "check")
    phases.push(["fmt", "-check", "-recursive"]);
  if (mode !== "fmt")
    phases.push(["init", "-backend=false", "-lockfile=readonly"]);
  if (mode === "validate" || mode === "check") phases.push(["validate"]);
  if (mode === "test" || mode === "check") phases.push(["test"]);

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  const onSigint = () => controller.abort("SIGINT");
  const onSigterm = () => controller.abort("SIGTERM");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (options.signal?.aborted) onAbort();
  try {
    for (const root of FOUNDATION_ROOTS) {
      for (const phase of phases) {
        await runTerraform({
          ...options,
          argv: ["--root", root, ...phase],
          signal: controller.signal,
        });
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runTerraformChecks(process.argv[2]).catch(reportTerraformFailure);
}
