import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { externalizeWebScripts } from "./externalize-web-scripts.ts";

test("SPA 起動スクリプトの内容と実行順を保ち inline JavaScript を外部化する", () => {
  const source = "window.bootstrap = {ready: true};";
  const hash = createHash("sha256").update(source).digest("hex");
  const result = externalizeWebScripts(
    `<!doctype html><html><head></head><body><script async defer>${source}</script><script type="module" async="">import "/assets/entry.js";</script><script>window.done = true;</script></body></html>`,
  );
  assert.equal(result.scripts.length, 3);
  assert.equal(result.scripts[0]?.content, source);
  assert.equal(result.scripts[0]?.src, `/assets/inline-${hash}.js`);
  assert.equal(result.scripts[1]?.content, 'import "/assets/entry.js";');
  assert.equal(result.scripts[2]?.content, "window.done = true;");
  assert.ok(
    result.html.includes(`<script src="/assets/inline-${hash}.js"></script>`),
  );
  assert.match(result.html, /<script type="module" src="[^"]+"><\/script>/u);
  assert.ok(
    result.html.indexOf(result.scripts[0].src) <
      result.html.indexOf(result.scripts[1].src),
  );
});

test("外部 script と JSON データと属性を壊さず、二重実行しても出力が変わらない", () => {
  const result = externalizeWebScripts(
    '<script src="/assets/existing.js" defer></script><script type="application/ld+json">{"name":"Example"}</script><script data-example="a > b">window.example = "<script>";</script>',
  );
  assert.equal(result.scripts.length, 1);
  assert.equal(result.scripts[0]?.content, 'window.example = "<script>";');
  assert.ok(
    result.html.includes('<script src="/assets/existing.js" defer></script>'),
  );
  assert.ok(
    result.html.includes(
      '<script type="application/ld+json">{"name":"Example"}</script>',
    ),
  );
  assert.match(result.html, /data-example="a > b"/u);
  const second = externalizeWebScripts(result.html);
  assert.equal(second.html, result.html);
  assert.deepEqual(second.scripts, []);
});

test("外部化できない import map を CSP で黙って壊さずビルドを拒否する", () => {
  assert.throws(
    () =>
      externalizeWebScripts('<script type="importmap">{"imports":{}}</script>'),
    /Inline import maps are unsupported/u,
  );
});
