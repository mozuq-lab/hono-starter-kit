import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseGitStateUnchanged,
  formatUtcTimestamp,
  readReleaseGitState,
} from "./release-git.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

const createGitRunner = (porcelain: string, head = `${commit}\n`) => {
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    calls,
    commandRunner: {
      run(command: string, args: readonly string[]) {
        calls.push({ args, command });
        if (args[0] === "rev-parse") return Promise.resolve(head);
        if (args[0] === "status") return Promise.resolve(porcelain);
        return Promise.reject(new Error(`unexpected ${command}`));
      },
    },
  };
};

test("a clean working tree yields the HEAD commit without a warning", async () => {
  const warnings: string[] = [];
  const { calls, commandRunner } = createGitRunner("");

  const state = await readReleaseGitState({
    allowDirty: false,
    commandRunner,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(state, { commit, dirty: false, status: "" });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
    ],
  );
});

test("release-git refuses a dirty working tree unless --allow-dirty is given", async () => {
  const { commandRunner } = createGitRunner(" M scripts/release-api.ts\n");

  await assert.rejects(
    readReleaseGitState({
      allowDirty: false,
      commandRunner,
      warn: () => undefined,
    }),
    {
      message:
        "The working tree has uncommitted changes. Commit them, or pass --allow-dirty in an emergency.",
    },
  );
});

test("release-git counts untracked files as uncommitted changes", async () => {
  const { commandRunner } = createGitRunner("?? scratch.txt\n");

  await assert.rejects(
    readReleaseGitState({
      allowDirty: false,
      commandRunner,
      warn: () => undefined,
    }),
    /--allow-dirty/u,
  );
});

test("release-git continues a dirty tree with --allow-dirty and warns", async () => {
  const warnings: string[] = [];
  const { commandRunner } = createGitRunner(" M README.md\n");

  const state = await readReleaseGitState({
    allowDirty: true,
    commandRunner,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(state, { commit, dirty: true, status: " M README.md\n" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /uncommitted changes/u);
});

test("release-git rejects a HEAD that is not a full commit id", async () => {
  const { commandRunner } = createGitRunner("", "HEAD\n");

  await assert.rejects(
    readReleaseGitState({
      allowDirty: false,
      commandRunner,
      warn: () => undefined,
    }),
    { message: "git rev-parse HEAD did not return a full commit id." },
  );
});

test("the dirty release timestamp is UTC yyyymmddhhmmss", () => {
  assert.equal(
    formatUtcTimestamp(new Date("2026-09-29T01:02:03.456Z")),
    "20260929010203",
  );
});

for (const [label, before, after] of [
  ["a clean tree gains a change", "", " M scripts/release-api.ts\n"],
  ["a dirty tree changes further", " M README.md\n", " M README.md\n?? x.ts\n"],
] as const) {
  test(`the re-check after the build stops when ${label}`, async () => {
    const { commandRunner } = createGitRunner(after);

    await assert.rejects(
      assertReleaseGitStateUnchanged({
        before: { commit, dirty: before !== "", status: before },
        commandRunner,
        consequence: "Nothing was pushed.",
      }),
      {
        message:
          "The working tree changed while the release was being built. Nothing was pushed.",
      },
    );
  });
}

test("the re-check after the build stops when HEAD moved", async () => {
  const { commandRunner } = createGitRunner("", `${"f".repeat(40)}\n`);

  await assert.rejects(
    assertReleaseGitStateUnchanged({
      before: { commit, dirty: false, status: "" },
      commandRunner,
      consequence: "Nothing was uploaded.",
    }),
    /changed while the release was being built/u,
  );
});

test("the re-check after the build passes when nothing changed", async () => {
  const { commandRunner } = createGitRunner(" M README.md\n");

  await assertReleaseGitStateUnchanged({
    before: { commit, dirty: true, status: " M README.md\n" },
    commandRunner,
    consequence: "Nothing was pushed.",
  });
});
