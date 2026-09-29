import assert from "node:assert/strict";
import test from "node:test";

import { stepsForAction } from "./compose.ts";

test("setup builds tools and runs dependency installation before migrations and seed", () => {
  assert.deepEqual(stepsForAction("setup"), [
    ["compose", "build", "deps", "migrate", "seed"],
    ["compose", "up", "-d", "--wait", "postgres"],
    ["compose", "run", "--rm", "deps"],
    ["compose", "run", "--rm", "--no-deps", "migrate"],
    ["compose", "run", "--rm", "--no-deps", "seed"],
  ]);
});

test("migrate starts PostgreSQL and installs dependencies before migration", () => {
  assert.deepEqual(stepsForAction("migrate"), [
    ["compose", "up", "-d", "--wait", "postgres"],
    ["compose", "run", "--rm", "deps"],
    ["compose", "run", "--rm", "--no-deps", "migrate"],
  ]);
});

test("seed starts PostgreSQL and installs dependencies before seeding", () => {
  assert.deepEqual(stepsForAction("seed"), [
    ["compose", "up", "-d", "--wait", "postgres"],
    ["compose", "run", "--rm", "deps"],
    ["compose", "run", "--rm", "--no-deps", "seed"],
  ]);
});

test("dev builds and starts the Compose project", () => {
  assert.deepEqual(stepsForAction("dev"), [["compose", "up", "--build"]]);
});

test("down preserves named volumes", () => {
  assert.deepEqual(stepsForAction("down"), [["compose", "down"]]);
});

test("unknown actions are rejected", () => {
  assert.throws(() => stepsForAction("destroy"), /Unknown Compose action/);
});
