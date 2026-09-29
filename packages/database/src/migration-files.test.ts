import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMigrationsDirectory,
  loadMigrationFiles,
} from "./migration-files.js";

const fixtureDirectories: string[] = [];

const createMigrationFixture = async (
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "starter-migrations-"));
  fixtureDirectories.push(directory);

  await Promise.all(
    Object.entries(files).map(([filename, contents]) =>
      writeFile(join(directory, filename), contents),
    ),
  );

  return directory;
};

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("loadMigrationFiles", () => {
  it("loads the complete repository migration sequence with checksums", async () => {
    const files = await loadMigrationFiles(defaultMigrationsDirectory);

    expect(files.map(({ filename }) => filename)).toEqual([
      "0001_create_projects.sql",
      "0002_add_project_version.sql",
      "0003_create_auth.sql",
      "0004_create_external_login_transactions.sql",
      "0005_add_project_owner_and_created_at.sql",
    ]);
    expect(files.map(({ checksum }) => checksum)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it("loads only numbered SQL migrations in lexical order", async () => {
    const directory = await createMigrationFixture({
      "0002_second.sql": "select 2;",
      "0001_first.sql": "select 1;",
      "notes.txt": "ignored",
    });

    const files = await loadMigrationFiles(directory);

    expect(files.map((file) => file.filename)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(files[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes the checksum over the exact file bytes", async () => {
    const directory = await createMigrationFixture({
      "0001_bytes.sql": new Uint8Array([0x73, 0x65, 0x6c, 0x65, 0x63, 0x74]),
    });

    const files = await loadMigrationFiles(directory);

    expect(files).toEqual([
      {
        filename: "0001_bytes.sql",
        checksum:
          "b1a36d25d9633ed2ac04939fcb614ccb2b513243c148f18694592ae037f9d35f",
        sql: "select",
      },
    ]);
  });

  it("rejects duplicate numeric prefixes", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
      "0001_second.sql": "select 2;",
    });

    await expect(loadMigrationFiles(directory)).rejects.toThrow(
      "Duplicate migration prefix: 0001",
    );
  });
});
