import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const certificatePattern =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const approvedSource = new URL(
  "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
);
const defaultCertsDirectory = fileURLToPath(
  new URL("../docker/certs/", import.meta.url),
);
const maximumResponseBytes = 2 * 1024 * 1024;
const responseTimeoutMilliseconds = 5_000;
const defaultFileSystem = Object.freeze({ mkdir, open, rename, rm });

// 差し替えるのは書き出しの 4 操作だけ。node の型をそのまま要求すると、テストの
// 偽物（wx で開いて writeFile/sync/close だけを持つもの）が入口を通れない。
type BundleFileHandle = {
  close(): Promise<unknown>;
  sync(): Promise<unknown>;
  writeFile(contents: string): Promise<unknown>;
};
type BundleFileSystem = {
  mkdir(directory: string, options: { recursive: boolean }): Promise<unknown>;
  open(
    filePath: string,
    flags: string,
    mode: number,
  ): Promise<BundleFileHandle>;
  rename(from: string, to: string): Promise<unknown>;
  rm(filePath: string, options: { force: boolean }): Promise<unknown>;
};

export const validateRdsCaBundle = ({
  pem,
  now = new Date(),
}: {
  pem: string;
  now?: Date;
}) => {
  if (pem.includes("PRIVATE KEY")) {
    throw new Error("RDS CA bundle must not contain a private key.");
  }
  const blocks = pem.match(certificatePattern) ?? [];
  if (
    blocks.length === 0 ||
    pem.replace(certificatePattern, "").trim() !== ""
  ) {
    throw new Error("RDS CA bundle must contain only PEM certificates.");
  }
  const certificates = blocks.map((block) => new X509Certificate(block));
  if (
    certificates.some(
      (certificate) =>
        now < new Date(certificate.validFrom) ||
        now >= new Date(certificate.validTo),
    )
  ) {
    throw new Error("RDS CA bundle contains an invalid-time certificate.");
  }
  return Object.freeze({
    certificateCount: certificates.length,
    sha256: createHash("sha256").update(pem).digest("hex"),
  });
};

export const checksumLineFor = (sha256: string) =>
  `${sha256}  global-bundle.pem\n`;

const readLimitedUtf8 = async (
  body: AsyncIterable<Uint8Array>,
  maximumBytes: number,
) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes) {
      throw new Error("RDS CA bundle response exceeded 2097152 bytes.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const writeSyncedExclusive = async (
  filePath: string,
  contents: string,
  openImpl: BundleFileSystem["open"],
  recordOwnership: () => void,
) => {
  const handle = await openImpl(filePath, "wx", 0o644);
  recordOwnership();
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const temporarySiblingFor = (filePath: string) =>
  `${filePath}.${randomBytes(16).toString("hex")}.tmp`;

const replaceValidatedBundle = async (
  { checksum, pem }: { checksum: string; pem: string },
  {
    certsDirectory = defaultCertsDirectory,
    fileSystem: injectedFileSystem = {},
  }: {
    certsDirectory?: string;
    fileSystem?: Partial<BundleFileSystem> | undefined;
  } = {},
) => {
  const fileSystem = { ...defaultFileSystem, ...injectedFileSystem };
  await fileSystem.mkdir(certsDirectory, { recursive: true });

  const bundlePath = join(certsDirectory, "global-bundle.pem");
  const checksumPath = join(certsDirectory, "global-bundle.pem.sha256");
  const temporaryBundlePath = temporarySiblingFor(bundlePath);
  const temporaryChecksumPath = temporarySiblingFor(checksumPath);
  const ownedTemporaryPaths = new Set<string>();
  let failure: Error | undefined;
  let phase = "stage";

  try {
    await writeSyncedExclusive(temporaryBundlePath, pem, fileSystem.open, () =>
      ownedTemporaryPaths.add(temporaryBundlePath),
    );
    await writeSyncedExclusive(
      temporaryChecksumPath,
      checksum,
      fileSystem.open,
      () => ownedTemporaryPaths.add(temporaryChecksumPath),
    );
    phase = "replace";
    await fileSystem.rename(temporaryBundlePath, bundlePath);
    ownedTemporaryPaths.delete(temporaryBundlePath);
    await fileSystem.rename(temporaryChecksumPath, checksumPath);
    ownedTemporaryPaths.delete(temporaryChecksumPath);
  } catch (error) {
    failure = new Error(
      phase === "stage"
        ? "Unable to stage the RDS CA bundle."
        : "Unable to replace the RDS CA bundle.",
      { cause: error },
    );
  }

  const cleanupResults = await Promise.allSettled(
    [...ownedTemporaryPaths].map((filePath) =>
      fileSystem.rm(filePath, { force: true }),
    ),
  );
  const cleanupFailures = cleanupResults.flatMap((result) =>
    result.status === "rejected"
      ? [
          new Error("Unable to clean a staged RDS CA bundle file.", {
            cause: result.reason,
          }),
        ]
      : [],
  );

  if (failure === undefined) return;
  if (cleanupFailures.length > 0) {
    const failures = [failure, ...cleanupFailures];
    throw new AggregateError(
      failures,
      `RDS CA bundle replacement and cleanup produced ${failures.length} failures.`,
      { cause: failure },
    );
  }
  throw failure;
};

export const refreshRdsCaBundle = async ({
  certsDirectory = defaultCertsDirectory,
  createTimeoutSignal = (milliseconds: number) =>
    globalThis.AbortSignal.timeout(milliseconds),
  fetchImpl = globalThis.fetch,
  fileSystem,
  now = new Date(),
  source = approvedSource,
}: {
  certsDirectory?: string | undefined;
  createTimeoutSignal?: ((milliseconds: number) => AbortSignal) | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
  fileSystem?: Partial<BundleFileSystem> | undefined;
  now?: Date | undefined;
  source?: URL | undefined;
} = {}) => {
  if (!(source instanceof URL) || source.protocol !== "https:") {
    throw new Error("RDS CA bundle source must use HTTPS.");
  }
  if (source.href !== approvedSource.href) {
    throw new Error(
      "RDS CA bundle source is not the approved RDS trust bundle.",
    );
  }

  const response = await fetchImpl(source, {
    redirect: "error",
    signal: createTimeoutSignal(responseTimeoutMilliseconds),
  });
  if (
    response.status !== 200 ||
    response.redirected ||
    response.body === null
  ) {
    throw new Error("Unable to download the RDS CA bundle.");
  }
  const pem = await readLimitedUtf8(response.body, maximumResponseBytes);
  const result = validateRdsCaBundle({ now, pem });
  await replaceValidatedBundle(
    {
      checksum: checksumLineFor(result.sha256),
      pem,
    },
    { certsDirectory, fileSystem },
  );
  return result;
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await refreshRdsCaBundle();
    console.log(
      `source=${approvedSource.hostname} certificates=${result.certificateCount} sha256=${result.sha256}`,
    );
  } catch {
    console.error("Unable to refresh the RDS CA bundle.");
    process.exitCode = 1;
  }
}
