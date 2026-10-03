import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runReleaseWeb } from "./release-web.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const bucket = "hono-starter-kit-dev-web-123456789012";

type Call = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
};

const createFakeRunner = ({
  porcelain = "",
  handler = () => undefined,
}: {
  porcelain?: string | readonly string[];
  handler?: (call: Call) => Promise<string> | undefined;
} = {}) => {
  const calls: Call[] = [];
  let statusCount = 0;
  // 配列なら git status の n 回目に n 番目を返す（build の前と後の確認を分けて与える）。
  const nextPorcelain = () => {
    if (typeof porcelain === "string") return porcelain;
    const value = porcelain[Math.min(statusCount, porcelain.length - 1)] ?? "";
    statusCount += 1;
    return value;
  };
  return {
    calls,
    commandRunner: {
      run(
        command: string,
        args: readonly string[],
        options: Record<string, unknown> = {},
      ): Promise<string | { stdout: string; stderr: string }> {
        const call = { args, command, options };
        calls.push(call);
        const handled = handler(call);
        if (handled !== undefined) return handled;
        if (command === "git" && args[0] === "rev-parse")
          return Promise.resolve(`${commit}\n`);
        if (command === "git" && args[0] === "status")
          return Promise.resolve(nextPorcelain());
        return Promise.resolve("");
      },
      terminateActiveChild: () => false,
    },
  };
};

const withBuild = async (
  hasIndex: boolean,
  body: (buildDirectory: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "release-web-test-"));
  const buildDirectory = join(root, "client");
  try {
    await mkdir(join(buildDirectory, "assets"), { recursive: true });
    await writeFile(join(buildDirectory, "assets", "entry-abc123.js"), "");
    if (hasIndex)
      await writeFile(join(buildDirectory, "index.html"), "<!doctype html>");
    await body(buildDirectory);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const baseOptions = (buildDirectory: string) => ({
  argv: ["--bucket", bucket],
  buildDirectory,
  log: () => undefined,
  now: () => new Date("2026-09-29T01:02:03.456Z"),
});

const s3Calls = (calls: readonly Call[]) =>
  calls.filter(({ command, args }) => command === "aws" && args[0] === "s3");

test("release-web uploads assets, then index.html, then release.json with distinct Cache-Control", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    await runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner });

    assert.deepEqual(
      s3Calls(calls).map(({ args }) => args),
      [
        [
          "s3",
          "sync",
          `${buildDirectory}/`,
          `s3://${bucket}/`,
          "--exclude",
          "index.html",
          "--cache-control",
          "public,max-age=31536000,immutable",
          "--no-cli-pager",
        ],
        [
          "s3",
          "cp",
          join(buildDirectory, "index.html"),
          `s3://${bucket}/index.html`,
          "--cache-control",
          "no-cache",
          "--content-type",
          "text/html; charset=utf-8",
          "--no-cli-pager",
        ],
        [
          "s3",
          "cp",
          "-",
          `s3://${bucket}/release.json`,
          "--cache-control",
          "no-cache",
          "--content-type",
          "application/json",
          "--no-cli-pager",
        ],
      ],
    );
    // 古い index.html を持つクライアントが参照する旧資産を残す。
    assert.equal(
      calls.some(({ args }) => args.includes("--delete")),
      false,
    );
    assert.equal(
      calls.some(({ args }) => args[0] === "cloudfront"),
      false,
    );
  });
});

test("release-web writes release.json through stdin with the commit, dirty flag, and release time", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    await runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner });

    const releaseJson = s3Calls(calls).find(({ args }) =>
      args.includes(`s3://${bucket}/release.json`),
    );
    assert.deepEqual(JSON.parse(String(releaseJson?.options.stdin)), {
      commit,
      dirty: false,
      releasedAt: "2026-09-29T01:02:03.456Z",
    });
  });
});

test("release-web marks release.json dirty when --allow-dirty releases a dirty tree", async () => {
  await withBuild(true, async (buildDirectory) => {
    const warnings: string[] = [];
    const { calls, commandRunner } = createFakeRunner({
      porcelain: " M apps/web/app/root.tsx\n",
    });

    await runReleaseWeb({
      ...baseOptions(buildDirectory),
      argv: ["--", "--bucket", bucket, "--allow-dirty"],
      commandRunner,
      log: (message) => warnings.push(message),
    });

    const releaseJson = s3Calls(calls).find(({ args }) =>
      args.includes(`s3://${bucket}/release.json`),
    );
    assert.equal(
      (JSON.parse(String(releaseJson?.options.stdin)) as { dirty: boolean })
        .dirty,
      true,
    );
    assert.ok(warnings.some((message) => /uncommitted changes/u.test(message)));
  });
});

test("release-web refuses a dirty working tree before uploading anything", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      porcelain: "?? notes.txt\n",
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      /--allow-dirty/u,
    );
    assert.deepEqual(s3Calls(calls), []);
  });
});

test("release-web stops when the web build produced no index.html", async () => {
  await withBuild(false, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      {
        message: `The web build did not produce ${join(buildDirectory, "index.html")}.`,
      },
    );
    assert.deepEqual(s3Calls(calls), []);
  });
});

const isWebBuild = ({ command, args }: Call) =>
  command === "pnpm" && args.join(" ") === "--filter @starter/web build";

// apps/web/build は gitignore されているので、clean な作業ツリーでも中身は HEAD から
// 作られたとは限らない。release:web 自身が HEAD から build する。
test("release-web builds the web app from HEAD after the git check and before any upload", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    await runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner });

    const buildIndex = calls.findIndex(isWebBuild);
    const firstStatus = calls.findIndex(
      ({ command, args }) => command === "git" && args[0] === "status",
    );
    const firstUpload = calls.findIndex(
      ({ command, args }) => command === "aws" && args[0] === "s3",
    );
    assert.ok(buildIndex > firstStatus && firstStatus >= 0);
    assert.ok(buildIndex < firstUpload);
    assert.equal(calls.filter(isWebBuild).length, 1);
  });
});

const isLockedInstall = ({ command, args }: Call) =>
  command === "pnpm" && args.join(" ") === "install --frozen-lockfile";

// pull の後に install を忘れると、古い依存のまま build が通り、release.json だけが HEAD の
// commit を名乗る。build の前に lockfile どおりの依存へ揃える。
test("release-web installs the locked dependencies after the git check and before the build", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    await runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner });

    const installIndex = calls.findIndex(isLockedInstall);
    const firstStatus = calls.findIndex(
      ({ command, args }) => command === "git" && args[0] === "status",
    );
    assert.ok(installIndex > firstStatus && firstStatus >= 0);
    assert.ok(installIndex < calls.findIndex(isWebBuild));
    assert.equal(calls.filter(isLockedInstall).length, 1);
  });
});

test("release-web builds and uploads nothing when the install fails", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: (call) =>
        isLockedInstall(call)
          ? Promise.reject(new Error("pnpm exited with status 1"))
          : undefined,
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      /pnpm exited with status 1/u,
    );
    assert.deepEqual(calls.filter(isWebBuild), []);
    assert.deepEqual(s3Calls(calls), []);
  });
});

test("release-web uploads nothing when the web build fails", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: (call) =>
        isWebBuild(call)
          ? Promise.reject(new Error("pnpm exited with status 1"))
          : undefined,
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      /pnpm exited with status 1/u,
    );
    assert.deepEqual(s3Calls(calls), []);
  });
});

test("release-web uploads nothing when the working tree changes during the build", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      porcelain: ["", " M apps/web/app/root.tsx\n"],
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      {
        message:
          "The working tree changed while the release was being built. Nothing was uploaded.",
      },
    );
    assert.deepEqual(s3Calls(calls), []);
  });
});

test("release-web uploads nothing when a dirty tree changes further during the build", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      porcelain: [" M README.md\n", " M README.md\n?? new-file.ts\n"],
    });

    await assert.rejects(
      runReleaseWeb({
        ...baseOptions(buildDirectory),
        argv: ["--bucket", bucket, "--allow-dirty"],
        commandRunner,
      }),
      /changed while the release was being built/u,
    );
    assert.deepEqual(s3Calls(calls), []);
  });
});

test("release-web invalidates only /index.html, last, when a distribution id is given", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    await runReleaseWeb({
      ...baseOptions(buildDirectory),
      argv: ["--bucket", bucket, "--distribution-id", "E1ABCDEF234567"],
      commandRunner,
    });

    assert.deepEqual(calls.at(-1)?.args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E1ABCDEF234567",
      "--paths",
      "/index.html",
      "--no-cli-pager",
    ]);
  });
});

test("release-web requires the AWS CLI", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: ({ command, args }) =>
        command === "aws" && args[0] === "--version"
          ? Promise.reject(new Error("Unable to start aws"))
          : undefined,
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      {
        message:
          "The AWS CLI (aws) is required to publish to AWS. Install it and configure credentials.",
      },
    );
    assert.deepEqual(s3Calls(calls), []);
  });
});

test("release-web stops at the first failed upload so index.html never points at missing assets", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: ({ args }) =>
        args[1] === "sync"
          ? Promise.reject(new Error("aws exited with status 1"))
          : undefined,
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      /aws exited with status 1/u,
    );
    assert.equal(s3Calls(calls).length, 1);
  });
});

test("release-web leaves release.json alone when index.html fails to upload", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner({
      handler: ({ args }) =>
        args.includes(`s3://${bucket}/index.html`)
          ? Promise.reject(new Error("aws exited with status 1"))
          : undefined,
    });

    await assert.rejects(
      runReleaseWeb({ ...baseOptions(buildDirectory), commandRunner }),
      /aws exited with status 1/u,
    );
    assert.equal(
      calls.some(({ args }) => args.includes(`s3://${bucket}/release.json`)),
      false,
    );
  });
});

test("release-web rejects a missing or malformed bucket and distribution id before running anything", async () => {
  await withBuild(true, async (buildDirectory) => {
    const { calls, commandRunner } = createFakeRunner();

    for (const argv of [
      [],
      ["--bucket", "s3://bucket"],
      ["--bucket", "Bucket_Name"],
      ["--bucket", bucket, "--distribution-id", "e1; rm -rf /"],
    ]) {
      await assert.rejects(
        runReleaseWeb({ ...baseOptions(buildDirectory), argv, commandRunner }),
        /--bucket|--distribution-id/u,
      );
    }
    assert.deepEqual(calls, []);
  });
});
