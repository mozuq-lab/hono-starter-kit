import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, serializeOuter, type DefaultTreeAdapterMap } from "parse5";

const javascriptTypes = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

export const externalizeWebScripts = (html: string) => {
  const scripts: { src: string; content: string }[] = [];
  const replacements: { start: number; end: number; html: string }[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]): void => {
    if ("tagName" in node && node.tagName === "script") {
      const type =
        node.attrs
          .find((attribute) => attribute.name === "type")
          ?.value.trim()
          .toLowerCase() ?? "";
      if (!node.attrs.some((attribute) => attribute.name === "src")) {
        if (type === "importmap") {
          throw new Error(
            "Inline import maps are unsupported by the static CSP build",
          );
        }
        if (javascriptTypes.has(type)) {
          const location = node.sourceCodeLocation;
          if (!location?.startTag || !location.endTag) {
            throw new Error(
              "Inline script must have explicit opening and closing tags",
            );
          }
          const content = html.slice(
            location.startTag.endOffset,
            location.endTag.startOffset,
          );
          const hash = createHash("sha256").update(content).digest("hex");
          const src = `/assets/inline-${hash}.js`;
          // classic は同期順を維持し、module は DOM の構築完了後に実行する。
          // src 付き async script は React が hydration 対象から除外するため、
          // module にも async を残すと元の inline script と照合できなくなる。
          node.attrs = node.attrs.filter(
            ({ name }) => name !== "async" && name !== "defer",
          );
          node.attrs.push({ name: "src", value: src });
          node.childNodes = [];
          scripts.push({ src, content });
          replacements.push({
            start: location.startOffset,
            end: location.endOffset,
            html: serializeOuter(node),
          });
        }
      }
      return;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  let output = html;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.html +
      output.slice(replacement.end);
  }
  return { html: output, scripts };
};

export const externalizeWebBuild = async (
  clientDirectory: string,
): Promise<void> => {
  const indexPath = join(clientDirectory, "index.html");
  const result = externalizeWebScripts(await readFile(indexPath, "utf8"));
  await mkdir(join(clientDirectory, "assets"), { recursive: true });
  await Promise.all(
    result.scripts.map(({ src, content }) =>
      writeFile(join(clientDirectory, src.slice(1)), content),
    ),
  );
  await writeFile(indexPath, result.html);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await externalizeWebBuild(
    fileURLToPath(new URL("../apps/web/build/client", import.meta.url)),
  );
}
