import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";

async function loadHandler() {
  const functionUrl = new URL("../function.js", import.meta.url);
  const source = await readFile(functionUrl, "utf8");
  const context = vm.createContext({});
  new vm.Script(`${source}\nthis.__handler = handler;`, {
    filename: functionUrl.pathname,
  }).runInContext(context);
  return context.__handler;
}

test("rewrites only SPA navigations and preserves CloudFront request metadata", async (t) => {
  const handler = await loadHandler();
  const cases = [
    ["/", "/index.html"],
    ["/projects", "/index.html"],
    ["/projects/", "/index.html"],
    ["/assets/app.abc.js", "/assets/app.abc.js"],
    ["/api", "/api"],
    ["/api/projects", "/api/projects"],
    ["/auth", "/auth"],
    ["/auth/callback", "/auth/callback"],
  ];

  assert.equal(typeof handler, "function");

  for (const [inputUri, expectedUri] of cases) {
    await t.test(inputUri, () => {
      const querystring = {
        page: { value: "2" },
      };
      const headers = {
        accept: { value: "text/html" },
      };
      const cookies = {
        session: { value: "opaque" },
      };
      const request = {
        method: "GET",
        uri: inputUri,
        querystring,
        headers,
        cookies,
      };

      const result = handler({ request });

      assert.strictEqual(result, request);
      assert.equal(result.uri, expectedUri);
      assert.equal(result.method, "GET");
      assert.strictEqual(result.querystring, querystring);
      assert.strictEqual(result.headers, headers);
      assert.strictEqual(result.cookies, cookies);
    });
  }
});
