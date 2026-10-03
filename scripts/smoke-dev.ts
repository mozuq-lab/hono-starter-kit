import console from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  checkAlbIsPrivate,
  loadExpectedSecurityHeaders,
  resolveAllAddresses,
  runHttpChecks,
  type ResolveAddresses,
  type SecurityHeaders,
  type SmokeFetch,
} from "./smoke-checks.ts";

// pnpm smoke:dev: release:web の後に、デプロイ済みの dev 環境を検査する。秘密情報は使わない。

const usage =
  "Usage: pnpm smoke:dev --origin <dev output app_origin> --alb-dns-name <dev output alb_dns_name>";

const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

const parseSmokeDevArguments = (argv: readonly string[]) => {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      "alb-dns-name": { type: "string" },
      origin: { type: "string" },
    },
    strict: true,
  });
  const origin = values.origin;
  const albDnsName = values["alb-dns-name"];
  if (origin === undefined || albDnsName === undefined) {
    throw new Error(usage);
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = undefined;
  }
  // パスや末尾の / を許すと、検査する URL が意図した場所からずれる。
  if (parsed?.protocol !== "https:" || parsed.origin !== origin) {
    throw new Error(
      `--origin must be an https origin without a path. ${usage}`,
    );
  }
  if (!hostnamePattern.test(albDnsName)) {
    throw new Error(`--alb-dns-name must be a hostname. ${usage}`);
  }
  return { albDnsName, origin };
};

export const runSmokeDev = async ({
  argv,
  fetchImpl = (url, init) => fetch(url, init),
  resolveAddresses = resolveAllAddresses,
  loadHeaders = loadExpectedSecurityHeaders,
  log = (message: string) => {
    console.log(message);
  },
  randomId = () => randomUUID(),
}: {
  argv: readonly string[];
  fetchImpl?: SmokeFetch;
  resolveAddresses?: ResolveAddresses;
  loadHeaders?: () => Promise<SecurityHeaders>;
  log?: (message: string) => void;
  randomId?: () => string;
}): Promise<boolean> => {
  const { albDnsName, origin } = parseSmokeDevArguments(argv);
  const expectedHeaders = await loadHeaders();
  const results = [
    ...(await runHttpChecks({
      origin,
      fetchImpl,
      expectedHeaders,
      randomId: randomId(),
    })),
    await checkAlbIsPrivate({ albDnsName, resolveAddresses }),
  ];
  for (const { detail, name, ok } of results) {
    log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  }
  const failed = results.filter((check) => !check.ok).length;
  log(
    failed === 0
      ? `All ${String(results.length)} checks passed.`
      : `${String(failed)} of ${String(results.length)} checks failed.`,
  );
  return failed === 0;
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!(await runSmokeDev({ argv: process.argv.slice(2) }))) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
