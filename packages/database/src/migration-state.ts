import { ActionableMigrationError } from "./migration-errors.js";

export type MigrationState = {
  filename: string;
  checksum: string;
};

export class MigrationChecksumMismatchError extends ActionableMigrationError {
  readonly filename: string;

  constructor(filename: string) {
    super(
      `Migration checksum mismatch: ${filename}. Restore the original applied migration bytes, then add a new forward migration for further changes.`,
      "MigrationChecksumMismatchError",
    );
    this.filename = filename;
  }
}

class MigrationHistoryError extends ActionableMigrationError {
  constructor(message: string) {
    super(message, "MigrationHistoryError");
  }
}

const migrationFilenamePattern = /^([0-9]{4})_[a-z0-9_]+\.sql$/;

const getMigrationPrefix = (filename: string): string => {
  const prefix = migrationFilenamePattern.exec(filename)?.[1];
  if (prefix === undefined) {
    throw new MigrationHistoryError(
      `Database migration history contains an invalid filename: ${filename}.`,
    );
  }
  return prefix;
};

export const getActionableMigrationStateErrorMessage = (
  error: unknown,
): string | undefined => {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (visited.has(candidate)) continue;
    visited.add(candidate);

    if (candidate instanceof ActionableMigrationError) {
      return candidate.message;
    }
    if (candidate instanceof AggregateError) {
      pending.unshift(...(candidate.errors as unknown[]));
    }
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "cause" in candidate
    ) {
      pending.push(candidate.cause);
    }
  }

  return undefined;
};

export const compareMigrationState = <Migration extends MigrationState>(
  local: readonly Migration[],
  applied: readonly MigrationState[],
): Migration[] => {
  const localByPrefix = new Map(
    local.map((migration) => [
      getMigrationPrefix(migration.filename),
      migration,
    ]),
  );
  const appliedByPrefix = new Map<string, MigrationState>();

  for (const migration of applied) {
    const prefix = getMigrationPrefix(migration.filename);
    const localMigration = localByPrefix.get(prefix);
    if (
      localMigration !== undefined &&
      localMigration.filename !== migration.filename
    ) {
      throw new MigrationHistoryError(
        `Database migration history conflict: prefix ${prefix} is recorded as ${migration.filename} but local migration is ${localMigration.filename}.`,
      );
    }

    const existing = appliedByPrefix.get(prefix);
    if (existing !== undefined && existing.filename !== migration.filename) {
      throw new MigrationHistoryError(
        `Database migration history has duplicate prefix ${prefix}: ${existing.filename}, ${migration.filename}.`,
      );
    }
    appliedByPrefix.set(prefix, migration);
  }

  const appliedByFilename = new Map(
    applied.map((migration) => [migration.filename, migration.checksum]),
  );
  const pending = local.filter((migration) => {
    const appliedChecksum = appliedByFilename.get(migration.filename);
    if (appliedChecksum === undefined) {
      return true;
    }
    if (appliedChecksum !== migration.checksum) {
      throw new MigrationChecksumMismatchError(migration.filename);
    }
    return false;
  });

  const databaseOnly = applied
    .filter(
      (migration) =>
        !local.some(({ filename }) => filename === migration.filename),
    )
    .map((migration) => ({
      ...migration,
      prefix: getMigrationPrefix(migration.filename),
    }))
    .sort((left, right) => left.prefix.localeCompare(right.prefix));

  if (databaseOnly.length === 0) {
    return pending;
  }

  const firstDatabaseOnly = databaseOnly[0];
  const firstPending = pending[0];
  if (firstDatabaseOnly !== undefined && firstPending !== undefined) {
    throw new MigrationHistoryError(
      `Database migration history diverges before ${firstDatabaseOnly.filename}: local migration ${firstPending.filename} is not applied.`,
    );
  }

  const latestLocal = [...local]
    .sort((left, right) =>
      getMigrationPrefix(left.filename).localeCompare(
        getMigrationPrefix(right.filename),
      ),
    )
    .at(-1);
  if (latestLocal !== undefined) {
    const latestLocalPrefix = getMigrationPrefix(latestLocal.filename);
    const nonLaterMigration = databaseOnly.find(
      ({ prefix }) => prefix <= latestLocalPrefix,
    );
    if (nonLaterMigration !== undefined) {
      throw new MigrationHistoryError(
        `Database migration history diverges: database-only migration ${nonLaterMigration.filename} must be later than local migration ${latestLocal.filename}.`,
      );
    }
  }

  return pending;
};
