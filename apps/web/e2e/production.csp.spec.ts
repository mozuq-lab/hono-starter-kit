import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const clientDirectory = fileURLToPath(
  new URL("../build/client/", import.meta.url),
);
const edgeSource = await readFile(
  new URL("../../../infra/terraform/modules/edge/main.tf", import.meta.url),
  "utf8",
);
const csp = /content_security_policy\s*=\s*"([^"]+)"/u.exec(edgeSource)?.[1];
if (!csp)
  throw new Error("CloudFront CSP is required for this acceptance test");

test("本番 CSP で SPA が hydrate し、未許可の inline script は実行されない", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://starter.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const asset = pathname.startsWith("/assets/");
    const path = asset
      ? join(clientDirectory, pathname)
      : join(clientDirectory, "index.html");
    let body = await readFile(path, "utf8");
    if (!asset)
      body = body.replace(
        "</head>",
        "<script>window.cspCanary = true;</script></head>",
      );
    await route.fulfill({
      body,
      contentType: !asset
        ? "text/html"
        : pathname.endsWith(".css")
          ? "text/css"
          : "text/javascript",
      headers: { "Content-Security-Policy": csp },
    });
  });
  await page.goto("http://starter.test/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/auth/login",
  );
  expect(await page.evaluate(() => Reflect.has(window, "cspCanary"))).toBe(
    false,
  );
  expect(errors).toEqual([]);
});
