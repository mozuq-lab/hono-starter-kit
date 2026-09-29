// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
const styles = readFileSync(stylesPath, "utf8");
const viteConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "vite.config.ts",
);
const viteConfig = readFileSync(viteConfigPath, "utf8");

describe("Tailwind導入", () => {
  it("ViteにTailwindプラグインを組み込む", () => {
    expect(viteConfig).toMatch(/@tailwindcss\/vite/u);
  });

  it("Tailwindをバンドル起点にする", () => {
    expect(styles).toMatch(/@import\s+"tailwindcss"/u);
  });

  it("独自クラス定義を残さない", () => {
    // 見た目はユーティリティと全体規則だけで作る。部品固有の
    // クラスを足す変更では、このテストが落ちるので一緒に整理する。
    expect(styles).not.toMatch(/^\s*\.[A-Za-z_-][\w-]*\s*[,{]/mu);
  });
});

describe("全体規則", () => {
  it("フォーカス表示を一箇所で統一する", () => {
    expect(styles).toMatch(/:focus-visible/u);
  });

  it("ダークモードで配色を切り替える", () => {
    expect(styles).toMatch(/prefers-color-scheme\s*:\s*dark/u);
  });
});
