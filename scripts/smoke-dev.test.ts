import assert from "node:assert/strict";
import test from "node:test";

import { runSmokeDev } from "./smoke-dev.ts";
import {
  createFakeFetch,
  createHealthyRoutes,
  testHeaders,
  testOrigin,
  type Routes,
} from "./smoke-test-support.ts";

const alb = "internal-dev-123.ap-northeast-1.elb.amazonaws.com";

const run = (
  argv: readonly string[],
  {
    overrides = {},
    addresses = ["10.0.1.5"],
  }: { overrides?: Routes; addresses?: string[] } = {},
) => {
  const lines: string[] = [];
  const outcome = runSmokeDev({
    argv,
    fetchImpl: createFakeFetch({ ...createHealthyRoutes(), ...overrides }),
    resolveAddresses: () => Promise.resolve(addresses),
    loadHeaders: () => Promise.resolve(testHeaders),
    log: (line) => {
      lines.push(line);
    },
    randomId: () => "test-id",
  });
  return { outcome, lines };
};

test("passes and reports every check when the environment is healthy", async () => {
  const { outcome, lines } = run([
    "--",
    "--origin",
    testOrigin,
    "--alb-dns-name",
    alb,
  ]);

  assert.equal(await outcome, true);
  assert.equal(lines.filter((line) => line.startsWith("PASS ")).length, 8);
  assert.equal(lines.at(-1), "All 8 checks passed.");
});

test("runs every check and reports failure when any check fails", async () => {
  const { outcome, lines } = run(
    ["--origin", testOrigin, "--alb-dns-name", alb],
    { addresses: ["52.95.1.1"] },
  );

  assert.equal(await outcome, false);
  assert.equal(lines.filter((line) => line.startsWith("PASS ")).length, 7);
  assert.match(
    lines.find((line) => line.startsWith("FAIL "))!,
    /ALB/u,
  );
  assert.equal(lines.at(-1), "1 of 8 checks failed.");
});

test("rejects arguments that would point the checks somewhere unintended", async () => {
  for (const argv of [
    [],
    ["--origin", testOrigin],
    ["--alb-dns-name", alb],
    ["--origin", "http://d111111abcdef8.cloudfront.net", "--alb-dns-name", alb],
    ["--origin", `${testOrigin}/`, "--alb-dns-name", alb],
    ["--origin", `${testOrigin}/projects`, "--alb-dns-name", alb],
    ["--origin", "not a url", "--alb-dns-name", alb],
    [
      "--origin",
      testOrigin,
      "--alb-dns-name",
      "http://internal-dev.elb.amazonaws.com",
    ],
    ["--origin", testOrigin, "--alb-dns-name", alb, "--extra"],
  ]) {
    await assert.rejects(
      run(argv).outcome,
      /Usage: pnpm smoke:dev|Unknown option/u,
      argv.join(" "),
    );
  }
});
