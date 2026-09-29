import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);

// YAML パーサーの依存は足さない方針なので、文字列として読む。コメント行は
// 「禁止事項を説明する文」に反応しないよう、判定の前に落とす。
const readWorkflows = async () => {
  const names = (await readdir(workflowsDirectory)).filter((name) =>
    name.endsWith(".yml"),
  );
  return Promise.all(
    names.sort().map(async (name) => {
      const raw = await readFile(new URL(name, workflowsDirectory), "utf8");
      const body = raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      return { name, body };
    }),
  );
};

test("ci and nightly workflows are defined", async () => {
  const names = (await readWorkflows()).map(({ name }) => name);

  assert.deepEqual(names, ["ci.yml", "docker-nightly.yml"]);
});

test("no workflow runs untrusted code with base-repository privileges", async () => {
  // どちらも fork からの PR のコードを、base 側の権限と secret で走らせ得る。
  const offending = (await readWorkflows())
    .filter(({ body }) => /\b(pull_request_target|workflow_run)\b/u.test(body))
    .map(({ name }) => name);

  assert.deepEqual(offending, []);
});

// CI deploy を作るときに、このテストを意図して変える。
test("no workflow requests an OIDC token", async () => {
  const offending = (await readWorkflows())
    .filter(({ body }) => /id-token\s*:\s*write/u.test(body))
    .map(({ name }) => name);

  assert.deepEqual(offending, []);
});

test("every action is pinned by a full commit SHA", async () => {
  const unpinned: string[] = [];
  for (const { name, body } of await readWorkflows()) {
    for (const match of body.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)) {
      if (!/@[0-9a-f]{40}$/u.test(match[1]!)) {
        unpinned.push(`${name}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(unpinned, []);
});

test("actions/checkout never persists credentials", async () => {
  const offending: string[] = [];
  for (const { name, body } of await readWorkflows()) {
    const lines = body.split("\n");
    lines.forEach((line, index) => {
      if (!/uses:\s*actions\/checkout@/u.test(line)) {
        return;
      }
      // 直後の with ブロック（次のステップの手前まで）だけを見る。
      const rest = lines.slice(index + 1);
      const end = rest.findIndex((next) => /^\s*-\s/u.test(next));
      const step = (end === -1 ? rest : rest.slice(0, end)).join("\n");
      if (!/persist-credentials:\s*false/u.test(step)) {
        offending.push(name);
      }
    });
  }

  assert.deepEqual(offending, []);
});

test("every workflow defaults to read-only contents permission", async () => {
  const offending = (await readWorkflows())
    .filter(
      ({ body }) => !/^permissions:\s*\n\s+contents:\s*read\s*$/mu.test(body),
    )
    .map(({ name }) => name);

  assert.deepEqual(offending, []);
});

test("ci runs check, e2e, terraform and db-integration on pull requests and main pushes", async () => {
  const ci = (await readWorkflows()).find(({ name }) => name === "ci.yml")!;

  for (const job of ["check", "e2e", "terraform", "db-integration"]) {
    assert.match(ci.body, new RegExp(`^  ${job}:`, "mu"));
  }
  assert.match(ci.body, /^\s+pull_request:/mu);
  assert.match(ci.body, /^\s+push:\s*\n\s+branches:\s*\[main\]/mu);
  assert.match(ci.body, /run: pnpm check$/mu);
  assert.match(ci.body, /run: pnpm terraform:check$/mu);
  assert.match(ci.body, /run: pnpm test:db$/mu);
});

test("nightly workflow runs check:docker on schedule and dispatch only", async () => {
  const nightly = (await readWorkflows()).find(
    ({ name }) => name === "docker-nightly.yml",
  )!;

  assert.match(nightly.body, /^\s+schedule:/mu);
  assert.match(nightly.body, /^\s+workflow_dispatch:/mu);
  assert.equal(/^\s+(pull_request|push):/mu.test(nightly.body), false);
  assert.match(nightly.body, /run: pnpm check:docker$/mu);
  assert.match(nightly.body, /cancel-in-progress:\s*false/u);
});

test("renovate enforces a release age and groups coupled versions", async () => {
  const config = JSON.parse(
    await readFile(new URL("../renovate.json", import.meta.url), "utf8"),
  ) as {
    minimumReleaseAge?: string;
    packageRules: { groupName?: string }[];
  };

  assert.ok(config.minimumReleaseAge);
  const groups = config.packageRules.map((rule) => rule.groupName);
  for (const group of ["terraform", "pnpm", "node", "terraform-providers"]) {
    assert.ok(groups.includes(group), `group ${group} is missing`);
  }
});

// group の照合は Renovate 本体で確かめている（dry run の結果は task-3-report.md）。
// ここでは、その確認で外れた条件が戻らないことを固定する。
test("renovate group rules match by the names Renovate actually assigns", async () => {
  const config = JSON.parse(
    await readFile(new URL("../renovate.json", import.meta.url), "utf8"),
  ) as {
    packageRules: {
      groupName?: string;
      matchDepNames?: string[];
      matchManagers?: string[];
      matchDepTypes?: string[];
    }[];
  };
  const rule = (name: string) =>
    config.packageRules.find(({ groupName }) => groupName === name)!;

  // 正規表現 manager の依存には depType が付かないので、depType で絞ると
  // TERRAFORM_IMAGE が group から外れて image と required_version が別 PR になる。
  assert.deepEqual(rule("terraform").matchDepNames, ["hashicorp/terraform"]);
  assert.equal(rule("terraform").matchDepTypes, undefined);
  assert.equal(rule("terraform").matchManagers, undefined);
  assert.deepEqual(rule("pnpm").matchDepNames, ["pnpm"]);
  // .node-version を扱う manager の名前は nodenv。
  assert.deepEqual(rule("node").matchDepNames, ["node"]);
  assert.deepEqual(rule("node").matchManagers?.sort(), [
    "dockerfile",
    "nodenv",
  ]);
});
