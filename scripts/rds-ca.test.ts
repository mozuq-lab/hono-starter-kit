import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { after, before, test, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  checksumLineFor,
  refreshRdsCaBundle,
  validateRdsCaBundle,
} from "./rds-ca.ts";

const execFileAsync = promisify(execFile);
const maximumResponseBytes = 2 * 1024 * 1024;
const officialSource = new URL(
  "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
);
const trackedCertificateNames = Object.freeze([
  "global-bundle.pem",
  "global-bundle.pem.sha256",
]);

// createTrackedFixture が返す、追跡対象ファイルの控え。
type TrackedFixture = {
  certsDirectory: string;
  originalBundleDigest: string;
  originalChecksum: string;
};

let certificateDirectory: URL | undefined = undefined;
let certificatePem = "";
let certificateRoot: string | undefined = undefined;
let validNow = new Date();
let notYetValidNow = new Date();
let expiredNow = new Date();

const sha256 = (contents: Buffer | string) =>
  createHash("sha256").update(contents).digest("hex");

const generateOneDayCertificate = async () => {
  certificateRoot = await mkdtemp(join(tmpdir(), "starter-rds-ca-test-"));
  const keyPath = join(certificateRoot, "test-ca-key.pem");
  const certificatePath = join(certificateRoot, "test-ca.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=RDS Bundle Test CA",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ]);
  certificatePem = await readFile(certificatePath, "utf8");
  const certificate = new X509Certificate(certificatePem);
  validNow = new Date();
  notYetValidNow = new Date(new Date(certificate.validFrom).getTime() - 1);
  expiredNow = new Date(certificate.validTo);
};

const createResponse = (
  chunks: readonly string[] | null,
  {
    redirected = false,
    status = 200,
  }: { redirected?: boolean; status?: number } = {},
) => {
  const body =
    chunks === null
      ? null
      : new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
            controller.close();
          },
        });
  const response = new globalThis.Response(body as BodyInit | null, {
    status,
  });
  if (redirected) {
    Object.defineProperty(response, "redirected", { value: true });
  }
  return response;
};

const createFileSystem = ({
  failOpenAt,
  failRenameAt,
  failWriteAt,
}: {
  failOpenAt?: number;
  failRenameAt?: number;
  failWriteAt?: number;
} = {}) => {
  let openCount = 0;
  let renameCount = 0;
  let writeCount = 0;

  return {
    async open(...args: Parameters<typeof open>) {
      openCount += 1;
      if (openCount === failOpenAt) throw new Error("injected open failure");
      const handle = await open(...args);
      return {
        async close() {
          await handle.close();
        },
        async sync() {
          await handle.sync();
        },
        async writeFile(contents: string) {
          writeCount += 1;
          if (writeCount === failWriteAt) {
            throw new Error("injected write failure");
          }
          await handle.writeFile(contents);
        },
      };
    },
    async rename(...args: Parameters<typeof rename>) {
      renameCount += 1;
      if (renameCount === failRenameAt) {
        throw new Error("injected rename failure");
      }
      await rename(...args);
    },
    async rm(...args: Parameters<typeof rm>) {
      await rm(...args);
    },
  };
};

const createTrackedFixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "starter-rds-ca-files-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const certsDirectory = join(root, "docker", "certs");
  await mkdir(certsDirectory, { recursive: true });
  await writeFile(
    join(certsDirectory, trackedCertificateNames[0]!),
    certificatePem,
  );
  await writeFile(
    join(certsDirectory, trackedCertificateNames[1]!),
    `${sha256(certificatePem)}  global-bundle.pem\n`,
  );
  return {
    certsDirectory,
    originalBundleDigest: sha256(certificatePem),
    originalChecksum: `${sha256(certificatePem)}  global-bundle.pem\n`,
  };
};

const assertNoTemporarySiblings = async (certsDirectory: string) => {
  const names = await readdir(certsDirectory);
  assert.equal(names.length, trackedCertificateNames.length);
  assert.equal(
    names.every((name) => trackedCertificateNames.includes(name)),
    true,
  );
};

const assertTrackedContentsUnchanged = async (fixture: TrackedFixture) => {
  assert.equal(
    sha256(await readFile(join(fixture.certsDirectory, "global-bundle.pem"))),
    fixture.originalBundleDigest,
  );
  assert.equal(
    await readFile(
      join(fixture.certsDirectory, "global-bundle.pem.sha256"),
      "utf8",
    ),
    fixture.originalChecksum,
  );
};

const assertTrackedFilesUnchanged = async (fixture: TrackedFixture) => {
  await assertTrackedContentsUnchanged(fixture);
  await assertNoTemporarySiblings(fixture.certsDirectory);
};

const assertTrackedBundleMatchesChecksum = async (certsDirectory: string) => {
  const pem = await readFile(join(certsDirectory, "global-bundle.pem"), "utf8");
  const checksum = await readFile(
    join(certsDirectory, "global-bundle.pem.sha256"),
    "utf8",
  );
  const validation = validateRdsCaBundle({ now: validNow, pem });
  assert.equal(checksum, checksumLineFor(validation.sha256));
  return validation;
};

const refreshFixture = async (
  fixture: TrackedFixture,
  {
    createTimeoutSignal = (milliseconds: number) =>
      globalThis.AbortSignal.timeout(milliseconds),
    fileSystem = createFileSystem(),
    pem = `${certificatePem}${certificatePem}`,
    response,
    source = officialSource,
  }: {
    createTimeoutSignal?: (milliseconds: number) => AbortSignal;
    fileSystem?: ReturnType<typeof createFileSystem>;
    pem?: string;
    response?: Response;
    source?: URL;
  } = {},
) =>
  refreshRdsCaBundle({
    certsDirectory: fixture.certsDirectory,
    createTimeoutSignal,
    fetchImpl: async () => response ?? createResponse([pem]),
    fileSystem,
    now: validNow,
    source,
  });

before(generateOneDayCertificate);

after(async () => {
  if (certificateRoot !== undefined) {
    await rm(certificateRoot, { force: true, recursive: true });
  }
});

test("tracked RDS trust material is valid and has an exact matching checksum", async () => {
  certificateDirectory = new URL("../docker/certs/", import.meta.url);
  const pem = await readFile(
    new URL("global-bundle.pem", certificateDirectory),
    "utf8",
  );
  const checksum = await readFile(
    new URL("global-bundle.pem.sha256", certificateDirectory),
    "utf8",
  );
  const validation = validateRdsCaBundle({ pem });

  assert.match(checksum, /^[0-9a-f]{64} {2}global-bundle\.pem\n$/u);
  assert.equal(checksum, checksumLineFor(validation.sha256));
  assert.ok(validation.certificateCount > 0);
});

test("validates every PEM certificate and returns the exact bundle digest", () => {
  const pem = `${certificatePem}${certificatePem}`;
  const result = validateRdsCaBundle({ now: validNow, pem });

  assert.deepEqual(result, {
    certificateCount: 2,
    sha256: sha256(pem),
  });
  assert.equal(Object.isFrozen(result), true);
  assert.match(
    checksumLineFor(result.sha256),
    /^[0-9a-f]{64} {2}global-bundle\.pem\n$/u,
  );
  assert.equal(checksumLineFor(result.sha256).endsWith("\n\n"), false);
});

test("rejects empty, mixed, malformed, and private-key PEM material", () => {
  for (const [pem, expected] of [
    ["", /must contain only PEM certificates/u],
    [
      `${certificatePem}not a certificate`,
      /must contain only PEM certificates/u,
    ],
    [
      "-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n",
      /error/u,
    ],
    [
      `${certificatePem}-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n`,
      /must not contain a private key/u,
    ],
  ] as [string, RegExp][]) {
    assert.throws(() => validateRdsCaBundle({ now: validNow, pem }), expected);
  }
});

test("rejects certificates before notBefore and at notAfter", () => {
  assert.throws(
    () => validateRdsCaBundle({ now: notYetValidNow, pem: certificatePem }),
    /invalid-time certificate/u,
  );
  assert.throws(
    () => validateRdsCaBundle({ now: expiredNow, pem: certificatePem }),
    /invalid-time certificate/u,
  );
});

test("refresh uses the official HTTPS source, redirect refusal, and a 5000 ms timeout", async (t) => {
  const fixture = await createTrackedFixture(t);
  const timeoutSignal = globalThis.AbortSignal.abort();
  let requestedSource: URL | RequestInfo | undefined;
  let requestedOptions: RequestInit | undefined;
  let requestedTimeout: number | undefined;

  const result = await refreshRdsCaBundle({
    certsDirectory: fixture.certsDirectory,
    createTimeoutSignal(milliseconds) {
      requestedTimeout = milliseconds;
      return timeoutSignal;
    },
    fetchImpl: async (source, options) => {
      requestedSource = source;
      requestedOptions = options;
      return createResponse([certificatePem, certificatePem]);
    },
    fileSystem: createFileSystem(),
    now: validNow,
  });

  assert.equal((requestedSource as URL).href, officialSource.href);
  assert.equal((requestedSource as URL).protocol, "https:");
  assert.equal(requestedOptions!.redirect, "error");
  assert.equal(requestedOptions!.signal, timeoutSignal);
  assert.equal(requestedTimeout, 5_000);
  assert.equal(result.certificateCount, 2);
  assert.equal(result.sha256, sha256(`${certificatePem}${certificatePem}`));
  assert.deepEqual(
    await assertTrackedBundleMatchesChecksum(fixture.certsDirectory),
    result,
  );
  await assertNoTemporarySiblings(fixture.certsDirectory);
});

test("accepts exactly 2 MiB and rejects the next streaming byte", async (t) => {
  const exactFixture = await createTrackedFixture(t);
  const exactPem = certificatePem.padEnd(maximumResponseBytes, " ");
  const exactResult = await refreshFixture(exactFixture, {
    response: createResponse([
      exactPem.slice(0, 1024 * 1024),
      exactPem.slice(1024 * 1024),
    ]),
  });
  assert.equal(exactResult.sha256, sha256(exactPem));
  await assertTrackedBundleMatchesChecksum(exactFixture.certsDirectory);

  const oversizedFixture = await createTrackedFixture(t);
  await assert.rejects(
    refreshFixture(oversizedFixture, {
      response: createResponse([
        exactPem.slice(0, 1024 * 1024),
        exactPem.slice(1024 * 1024),
        " ",
      ]),
    }),
    /exceeded 2097152 bytes/u,
  );
  await assertTrackedFilesUnchanged(oversizedFixture);
});

test("rejects non-HTTPS sources before fetching or changing tracked files", async (t) => {
  const fixture = await createTrackedFixture(t);
  await assert.rejects(
    refreshRdsCaBundle({
      certsDirectory: fixture.certsDirectory,
      fetchImpl: async () => {
        throw new Error("unexpected fetch");
      },
      fileSystem: createFileSystem(),
      now: validNow,
      source: new URL(
        "http://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
      ),
    }),
    /must use HTTPS/u,
  );
  await assertTrackedFilesUnchanged(fixture);
});

test("rejects HTTPS sources other than the approved RDS truststore object", async (t) => {
  const fixture = await createTrackedFixture(t);
  await assert.rejects(
    refreshRdsCaBundle({
      certsDirectory: fixture.certsDirectory,
      fetchImpl: async () => {
        throw new Error("unexpected fetch");
      },
      fileSystem: createFileSystem(),
      now: validNow,
      source: new URL("https://example.com/global-bundle.pem"),
    }),
    /not the approved RDS trust bundle/u,
  );
  await assertTrackedFilesUnchanged(fixture);
});

test("rejects redirected and non-200 responses without changing tracked files", async (t) => {
  for (const response of [
    createResponse([certificatePem], { redirected: true }),
    createResponse([certificatePem], { status: 201 }),
  ]) {
    await t.test(response.redirected ? "redirected" : "non-200", async (t) => {
      const fixture = await createTrackedFixture(t);
      await assert.rejects(
        refreshFixture(fixture, { response }),
        /Unable to download the RDS CA bundle/u,
      );
      await assertTrackedFilesUnchanged(fixture);
    });
  }
});

test("rejects null, empty, malformed, and invalid-time bodies before changing files", async (t) => {
  for (const [name, response, now] of [
    ["null", createResponse(null), validNow],
    ["empty", createResponse([]), validNow],
    ["malformed", createResponse(["not PEM"]), validNow],
    ["not-yet-valid", createResponse([certificatePem]), notYetValidNow],
    ["expired", createResponse([certificatePem]), expiredNow],
  ] as [string, Response, Date][]) {
    await t.test(name, async (t) => {
      const fixture = await createTrackedFixture(t);
      await assert.rejects(
        refreshRdsCaBundle({
          certsDirectory: fixture.certsDirectory,
          fetchImpl: async () => response,
          fileSystem: createFileSystem(),
          now,
        }),
      );
      await assertTrackedFilesUnchanged(fixture);
    });
  }
});

test("open and write failures preserve tracked files and remove owned siblings", async (t) => {
  for (const [name, fileSystem] of [
    ["open", createFileSystem({ failOpenAt: 2 })],
    ["write", createFileSystem({ failWriteAt: 2 })],
  ] as [string, ReturnType<typeof createFileSystem>][]) {
    await t.test(name, async (t) => {
      const fixture = await createTrackedFixture(t);
      await assert.rejects(
        refreshFixture(fixture, { fileSystem }),
        /Unable to stage the RDS CA bundle/u,
      );
      await assertTrackedFilesUnchanged(fixture);
    });
  }
});

test("an exclusive-open collision never deletes the unowned staged pathname", async (t) => {
  const fixture = await createTrackedFixture(t);
  const sentinel = "unowned sentinel";
  let sentinelPath: string | undefined = undefined;
  let openCount = 0;
  const removedPaths: string[] = [];
  const realFileSystem = createFileSystem();
  const fileSystem = {
    ...realFileSystem,
    async open(...[filePath, flags, mode]: Parameters<typeof open>) {
      openCount += 1;
      if (openCount === 1) {
        return realFileSystem.open(filePath, flags, mode);
      }
      sentinelPath = filePath as string;
      await writeFile(filePath, sentinel, { flag: flags, mode });
      const error = new Error("injected exclusive-open collision");
      Object.defineProperty(error, "code", { value: "EEXIST" });
      throw error;
    },
    async rm(...[filePath, options]: Parameters<typeof rm>) {
      removedPaths.push(filePath as string);
      await realFileSystem.rm(filePath, options);
    },
  };

  await assert.rejects(
    refreshFixture(fixture, { fileSystem }),
    /Unable to stage the RDS CA bundle/u,
  );

  assert.equal(removedPaths.length, 1);
  assert.equal(removedPaths.includes(sentinelPath!), false);
  assert.equal(await readFile(sentinelPath!, "utf8"), sentinel);
  await assertTrackedContentsUnchanged(fixture);
  const names = await readdir(fixture.certsDirectory);
  assert.equal(names.length, 3);
  assert.equal(names.includes(basename(sentinelPath!)), true);
});

test("a first rename failure preserves tracked files and removes owned siblings", async (t) => {
  const fixture = await createTrackedFixture(t);
  await assert.rejects(
    refreshFixture(fixture, {
      fileSystem: createFileSystem({ failRenameAt: 1 }),
    }),
    /Unable to replace the RDS CA bundle/u,
  );
  await assertTrackedFilesUnchanged(fixture);
});

test("a partial second-rename commit is rejected by normal checksum validation", async (t) => {
  const fixture = await createTrackedFixture(t);
  await assert.rejects(
    refreshFixture(fixture, {
      fileSystem: createFileSystem({ failRenameAt: 2 }),
    }),
    /Unable to replace the RDS CA bundle/u,
  );
  await assert.rejects(
    assertTrackedBundleMatchesChecksum(fixture.certsDirectory),
    /Expected values to be strictly equal/u,
  );
  await assertNoTemporarySiblings(fixture.certsDirectory);
});

test("a successfully renamed pathname is not removed after another owner reuses it", async (t) => {
  const fixture = await createTrackedFixture(t);
  const sentinel = "post-rename unowned sentinel";
  let renameCount = 0;
  let sentinelPath: string | undefined = undefined;
  const removedPaths: unknown[] = [];
  const realFileSystem = createFileSystem();
  const fileSystem = {
    ...realFileSystem,
    async rename(...[sourcePath, destinationPath]: Parameters<typeof rename>) {
      renameCount += 1;
      if (renameCount === 1) {
        await realFileSystem.rename(sourcePath, destinationPath);
        sentinelPath = sourcePath as string;
        await writeFile(sentinelPath, sentinel, { flag: "wx", mode: 0o644 });
        return;
      }
      throw new Error("injected second rename failure");
    },
    async rm(...[filePath, options]: Parameters<typeof rm>) {
      removedPaths.push(filePath);
      await realFileSystem.rm(filePath, options);
    },
  };

  await assert.rejects(
    refreshFixture(fixture, { fileSystem }),
    /Unable to replace the RDS CA bundle/u,
  );

  assert.equal(removedPaths.length, 1);
  assert.equal(removedPaths.includes(sentinelPath!), false);
  assert.equal(await readFile(sentinelPath!, "utf8"), sentinel);
  await assert.rejects(
    assertTrackedBundleMatchesChecksum(fixture.certsDirectory),
    /Expected values to be strictly equal/u,
  );
  const names = await readdir(fixture.certsDirectory);
  assert.equal(names.length, 3);
  assert.equal(names.includes(basename(sentinelPath!)), true);
});

test("a staged cleanup failure is combined with replacement failure after every owned cleanup is attempted", async (t) => {
  const fixture = await createTrackedFixture(t);
  const removedPaths: string[] = [];
  const realFileSystem = createFileSystem({ failRenameAt: 1 });
  const fileSystem = {
    ...realFileSystem,
    async rm(...[filePath, options]: Parameters<typeof rm>) {
      removedPaths.push(filePath as string);
      if (removedPaths.length === 1) {
        throw new Error("injected staged cleanup failure");
      }
      await realFileSystem.rm(filePath, options);
    },
  };

  await assert.rejects(refreshFixture(fixture, { fileSystem }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(
      error.message,
      "RDS CA bundle replacement and cleanup produced 2 failures.",
    );
    assert.equal(error.errors.length, 2);
    assert.equal(
      (error.errors[0] as Error).message,
      "Unable to replace the RDS CA bundle.",
    );
    assert.equal(
      (error.errors[1] as Error).message,
      "Unable to clean a staged RDS CA bundle file.",
    );
    assert.equal(error.cause, error.errors[0]);
    return true;
  });

  assert.equal(removedPaths.length, 2);
  assert.equal(new Set(removedPaths).size, 2);
  assert.equal(
    removedPaths.every(
      (filePath) =>
        dirname(filePath) === fixture.certsDirectory &&
        basename(filePath).endsWith(".tmp") &&
        !trackedCertificateNames.includes(basename(filePath)),
    ),
    true,
  );
  await assertTrackedContentsUnchanged(fixture);
  const names = await readdir(fixture.certsDirectory);
  assert.equal(names.length, 3);
  assert.equal(names.includes(basename(removedPaths[0]!)), true);
  assert.equal(names.includes(basename(removedPaths[1]!)), false);
});

test("temporary files are exclusive owned siblings of the tracked files", async (t) => {
  const fixture = await createTrackedFixture(t);
  const openedFiles: { filePath: string; flags: unknown; mode: unknown }[] = [];
  let closeCount = 0;
  let syncCount = 0;
  const realFileSystem = createFileSystem();
  const fileSystem = {
    ...realFileSystem,
    async open(...[filePath, flags, mode]: Parameters<typeof open>) {
      openedFiles.push({ filePath: filePath as string, flags, mode });
      const handle = await realFileSystem.open(filePath, flags, mode);
      return {
        async close() {
          closeCount += 1;
          await handle.close();
        },
        async sync() {
          syncCount += 1;
          await handle.sync();
        },
        async writeFile(contents: string) {
          await handle.writeFile(contents);
        },
      };
    },
  };

  await refreshFixture(fixture, { fileSystem });

  assert.equal(openedFiles.length, 2);
  assert.equal(
    openedFiles.every(
      ({ filePath }) =>
        dirname(filePath) === fixture.certsDirectory &&
        !trackedCertificateNames.includes(basename(filePath)),
    ),
    true,
  );
  assert.equal(
    openedFiles.every(({ filePath }) => basename(filePath).endsWith(".tmp")),
    true,
  );
  assert.equal(
    openedFiles.every(({ flags, mode }) => flags === "wx" && mode === 0o644),
    true,
  );
  assert.equal(syncCount, 2);
  assert.equal(closeCount, 2);
  await assertNoTemporarySiblings(fixture.certsDirectory);
});
