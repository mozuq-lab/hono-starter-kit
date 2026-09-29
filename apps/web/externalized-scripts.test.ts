// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { expect, it } from "vitest";
import { externalizeWebScripts } from "../../scripts/externalize-web-scripts.js";

it("外部化した React Router の起動 script を hydration で読み飛ばさない", async () => {
  const transformed = externalizeWebScripts(
    '<!doctype html><html lang="ja"><head></head><body><main aria-busy="true">Projects を読み込んでいます。</main><script>window.__reactRouterContext = {};</script><script type="module" async="">window.__reactRouterRouteModules = {}; import("/assets/entry.client.js");</script></body></html>',
  );
  document.open();
  document.write(transformed.html);
  document.close();

  const recoverableErrors: unknown[] = [];
  let root: Root | undefined;
  try {
    await act(() => {
      root = hydrateRoot(
        document,
        createElement(
          "html",
          { lang: "ja" },
          createElement("head"),
          createElement(
            "body",
            null,
            createElement(
              "main",
              { "aria-busy": true },
              "Projects を読み込んでいます。",
            ),
            createElement("script", {
              suppressHydrationWarning: true,
              dangerouslySetInnerHTML: { __html: " " },
            }),
            // React Router はクライアントでも src のない async module を期待する。
            // 属性警告の抑制だけでは、別 script と判断されるノードの読み飛ばしを防げない。
            createElement("script", {
              type: "module",
              async: true,
              suppressHydrationWarning: true,
              dangerouslySetInnerHTML: { __html: " " },
            }),
          ),
        ),
        { onRecoverableError: (error) => recoverableErrors.push(error) },
      );
      return Promise.resolve();
    });

    expect(recoverableErrors).toEqual([]);
  } finally {
    act(() => root?.unmount());
  }
});
