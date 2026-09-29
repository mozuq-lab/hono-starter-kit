import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const assumeScript = path.join(repositoryRoot, "scripts/aws/assume.sh");

test("assume.sh is valid Bash and rejects direct execution before AWS", async () => {
  const syntax = spawnSync("bash", ["-n", assumeScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const direct = spawnSync(assumeScript, [], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    shell: false,
  });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /source して使ってください/u);
});

test("assume.sh contains no literal AWS session credentials", async () => {
  const source = await fs.readFile(assumeScript, "utf8");
  assert.doesNotMatch(source, /(?:AKIA|ASIA)[A-Z0-9]{16}/u);
  assert.doesNotMatch(
    source,
    /AWS_SECRET_ACCESS_KEY=["']?[A-Za-z0-9/+=]{30,}/u,
  );
  assert.doesNotMatch(source, /AWS_SESSION_TOKEN=["']?[A-Za-z0-9/+=]{80,}/u);
});

test("assume.sh clears temporary credentials before exporting a validated response", async () => {
  const source = await fs.readFile(assumeScript, "utf8");
  const assumeRoleStart = source.indexOf("aws sts assume-role");

  assert.ok(
    assumeRoleStart >= 0,
    "expected one aws sts assume-role invocation",
  );
  assert.equal((source.match(/aws sts assume-role/gu) ?? []).length, 1);
  assert.match(source, /"\$\{CREDS_ENV\[@\]\}" aws sts assume-role/u);
  const credentialsEnvironmentStart = source.indexOf("CREDS_ENV=");
  assert.ok(
    credentialsEnvironmentStart >= 0 &&
      credentialsEnvironmentStart < assumeRoleStart,
    "the scrubbed credential environment must be declared before the STS call",
  );
  const credentialsEnvironment = source.slice(
    credentialsEnvironmentStart,
    source.indexOf("\n\n", credentialsEnvironmentStart),
  );
  for (const credential of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_EXPIRATION",
  ]) {
    assert.match(credentialsEnvironment, new RegExp(`-u ${credential}`, "u"));
  }

  const jqReads = [
    "Credentials.AccessKeyId",
    "Credentials.SecretAccessKey",
    "Credentials.SessionToken",
    "Credentials.Expiration",
  ].map((field) => source.indexOf(`jq -r '.${field}'`));
  for (const index of jqReads) {
    assert.ok(
      index >= 0,
      "expected all required credentials to be read with jq",
    );
  }

  const validation = source.indexOf(
    'if [[ -z "$_AKID" || "$_AKID" == "null" ]]',
  );
  assert.ok(validation >= 0, "expected a complete-response validation guard");

  const exports = [...source.matchAll(/^export AWS_/gmu)].map(
    (match) => match.index,
  );
  const firstExport = exports[0];
  assert.ok(
    firstExport! > validation,
    "credentials must be exported after validation",
  );
  for (const index of jqReads) {
    assert.ok(
      firstExport! > index,
      "credentials must be exported after every jq read",
    );
  }

  const requiredCleanup = "unset JSON _AKID _SAK _TOK _EXP MFA_CODE";
  const cleanups = [...source.matchAll(new RegExp(requiredCleanup, "gu"))].map(
    (match) => match.index,
  );
  assert.equal(
    cleanups.length,
    2,
    "expected cleanup in both malformed-response and success branches",
  );
  assert.ok(
    cleanups[0]! > validation && cleanups[0]! < firstExport!,
    "malformed responses must clear temporary values before exports",
  );
  assert.ok(
    cleanups[1]! > exports.at(-1)!,
    "successful responses must clear temporary values after exports",
  );
});
