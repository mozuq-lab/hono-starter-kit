// vite.config.ts が公開するプロキシ解決関数の単体テスト。Vitest 用の設定ファイルではない。
import { describe, expect, it } from "vitest";

import { createProxyConfig, resolveApiProxyTarget } from "./vite.config.js";

describe("resolveApiProxyTarget", () => {
  it("uses the local API when no proxy target is configured", () => {
    expect(resolveApiProxyTarget({})).toBe("http://127.0.0.1:3000");
  });

  it("uses the configured API proxy target", () => {
    expect(resolveApiProxyTarget({ API_PROXY_TARGET: "http://api:3000" })).toBe(
      "http://api:3000",
    );
  });

  it("follows the E2E API port so the dev server proxies the harness API", () => {
    expect(resolveApiProxyTarget({ E2E_API_PORT: "4321" })).toBe(
      "http://127.0.0.1:4321",
    );
  });

  it("prefers an explicit proxy target over the E2E API port", () => {
    expect(
      resolveApiProxyTarget({
        API_PROXY_TARGET: "http://api:3000",
        E2E_API_PORT: "4321",
      }),
    ).toBe("http://api:3000");
  });

  it("proxies API and authentication requests to the same server", () => {
    expect(createProxyConfig("http://api:3000")).toEqual({
      "/api": "http://api:3000",
      "/auth": "http://api:3000",
    });
  });
});
