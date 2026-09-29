import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";

const actionSteps = {
  setup: [
    ["compose", "build", "deps", "migrate", "seed"],
    ["compose", "up", "-d", "--wait", "postgres"],
    ["compose", "run", "--rm", "deps"],
    ["compose", "run", "--rm", "--no-deps", "migrate"],
    ["compose", "run", "--rm", "--no-deps", "seed"],
  ],
  migrate: [
    ["compose", "up", "-d", "--wait", "postgres"],
    ["compose", "run", "--rm", "deps"],
    ["compose", "run", "--rm", "--no-deps", "migrate"],
  ],
  seed: [
    ["compose", "up", "-d", "--wait", "postgres"],
    ["compose", "run", "--rm", "deps"],
    ["compose", "run", "--rm", "--no-deps", "seed"],
  ],
  dev: [["compose", "up", "--build"]],
  down: [["compose", "down"]],
};

// 索く前に鍵であることを確かめる。Object.hasOwn は型を絞らないので同じ判定を述語で書く。
const isComposeAction = (action: unknown): action is keyof typeof actionSteps =>
  Object.hasOwn(actionSteps, action as PropertyKey);

export const stepsForAction = (action: string | undefined) => {
  const steps = isComposeAction(action) ? actionSteps[action] : undefined;
  if (steps === undefined) {
    throw new Error(`Unknown Compose action: ${action ?? "(missing)"}`);
  }

  return steps.map((step) => [...step]);
};

const execute = (action: string | undefined) => {
  const steps = stepsForAction(action);

  for (const args of steps) {
    const result = spawnSync("docker", args, { stdio: "inherit" });
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    execute(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
