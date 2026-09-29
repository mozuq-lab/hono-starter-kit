// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
const styles = readFileSync(stylesPath, "utf8");

describe("共通デザイン", () => {
  it("デザイントークンで配色と角丸を統一する", () => {
    expect(styles).toMatch(/--brand\s*:/u);
    expect(styles).toMatch(/--surface\s*:/u);
    expect(styles).toMatch(/--radius\s*:/u);
  });

  it("カードに奥行きを持たせる", () => {
    expect(styles).toMatch(/\.project-card[\s\S]*?box-shadow/u);
    expect(styles).toMatch(/\.login-card[\s\S]*?box-shadow/u);
  });

  it("ダークモードで配色を切り替える", () => {
    expect(styles).toMatch(/prefers-color-scheme\s*:\s*dark/u);
  });
});
