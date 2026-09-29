import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationFilenamePattern = /^([0-9]{4})_[a-z0-9_]+\.sql$/;

export type MigrationFile = {
  filename: string;
  checksum: string;
  sql: string;
};

export const defaultMigrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export const loadMigrationFiles = async (
  directory: string = defaultMigrationsDirectory,
): Promise<MigrationFile[]> => {
  const filenames = (await readdir(directory))
    .filter((filename) => migrationFilenamePattern.test(filename))
    .sort((left, right) => left.localeCompare(right));
  const prefixes = new Set<string>();

  for (const filename of filenames) {
    const prefix = migrationFilenamePattern.exec(filename)?.[1];
    if (prefix === undefined) {
      continue;
    }
    if (prefixes.has(prefix)) {
      throw new Error(`Duplicate migration prefix: ${prefix}`);
    }
    prefixes.add(prefix);
  }

  return Promise.all(
    filenames.map(async (filename) => {
      const contents = await readFile(join(directory, filename));
      return {
        filename,
        checksum: createHash("sha256").update(contents).digest("hex"),
        sql: contents.toString("utf8"),
      };
    }),
  );
};
