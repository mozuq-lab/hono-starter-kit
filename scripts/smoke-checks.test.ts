import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readExpectedSecurityHeaders } from "./smoke-checks.ts";

const edgeMain = new URL(
  "../infra/terraform/modules/edge/main.tf",
  import.meta.url,
);

test("reads the five security headers from the edge response headers policy", async () => {
  const headers = readExpectedSecurityHeaders(await readFile(edgeMain, "utf8"));

  assert.deepEqual(Object.keys(headers).sort(), [
    "content-security-policy",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
  ]);
  assert.match(headers["content-security-policy"]!, /^default-src 'none';/u);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(
    headers["strict-transport-security"],
    "max-age=31536000; includeSubDomains",
  );
});

test("adds preload to HSTS only when the policy enables it", async () => {
  const source = (await readFile(edgeMain, "utf8")).replace(
    /preload\s*=\s*false/u,
    "preload = true",
  );

  assert.equal(
    readExpectedSecurityHeaders(source)["strict-transport-security"],
    "max-age=31536000; includeSubDomains; preload",
  );
});

test("refuses to guess when the policy can no longer be read", async () => {
  const source = (await readFile(edgeMain, "utf8")).replace(
    /frame_option\s*=\s*"DENY"/u,
    "",
  );

  assert.throws(() => readExpectedSecurityHeaders(source), /frame_option/u);
});
