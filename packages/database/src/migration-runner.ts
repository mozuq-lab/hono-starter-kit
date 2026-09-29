import type { Pool, PoolClient, QueryResultRow } from "pg";
import { runWithCleanup } from "./cleanup.js";
import {
  MigrationChangesSessionSettingsError,
  MigrationChangesStatementTimeoutError,
  MigrationControlsTransactionError,
  MigrationLockRetriesExhaustedError,
  MigrationLockWaitExceededError,
  MigrationStatementTimeoutError,
} from "./migration-errors.js";
import {
  defaultMigrationsDirectory,
  loadMigrationFiles,
  type MigrationFile,
} from "./migration-files.js";
import {
  compareMigrationState,
  type MigrationState,
} from "./migration-state.js";

const advisoryLockKeys: [number, number] = [107402177, 20260805];
const migrateCommand = "pnpm db:migrate";
const readAppliedSql = `
  select filename, checksum
  from starter_migrations
  order by filename asc
`;

// 前提: migration は ECS タスクの起動ごとに sidecar として走る。デプロイでもスケールアウトでも
// 障害からの再起動でも毎回走り、常に旧タスクが本番のトラフィックを捌いている最中に走る。
// 複数のタスクが同時に起動すれば、migrator 同士が advisory lock を取り合う。
//
// 各 migration のトランザクションの上限。DDL が旧タスクの長いクエリの後ろで
// ACCESS EXCLUSIVE を待つと、その後ろに API のクエリがすべて並んでテーブル全体が止まる。
// lock_timeout で早めに諦め、一時的な衝突は再試行で吸収する。
const migrationLockTimeout = "5s";
const migrationStatementTimeout = "5min";
const maxMigrationAttempts = 5;
const retryBackoffBaseMillis = 1_000;

// 1 本あたりの最長時間 W。先行の migrator が正常に終わるまでに要しうる時間以上にする。
//   長く走る文の実行: 5 分（statement_timeout。長く走る文は 1 本に 1 つだけという前提）
//   ロック待ち: 5 秒 × ロック取得の回数 × 5 回（lock_timeout はロックの取得ごとに効く。
//     4 つのオブジェクトのロックを取る DDL なら 100 秒）
//   バックオフ: 1 + 2 + 4 + 8 = 15 秒
// 合計は約 7 分。余裕を持たせて 10 分にする。
// migration の SQL で statement_timeout や lock_timeout を変える（RESET ALL で外すことも含む）と
// この前提が崩れるので、runner が拒否する。
const defaultAdvisoryLockWaitPerMigrationMillis = 10 * 60_000;

const changesStatementTimeout = /statement_timeout/iu;
// deadlock_timeout は別の設定なので、直前が識別子の文字でないものだけを拾う。
const changesSessionSettings = /(?<![a-z0-9_])lock_timeout|\breset\s+all\b/iu;

const identifierStart = /[A-Za-z_]/u;
const identifierPart = /[A-Za-z0-9_$]/u;
const dollarQuoteTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

// 各文の先頭 2 語（小文字）を返す。コメント、文字列、引用識別子、dollar quote の中は読み飛ばす
// ので、PL/pgSQL の本体の BEGIN … END や、文字列の中の "commit" は文として数えない。
const statementLeadingWords = (sql: string): string[][] => {
  const statements: string[][] = [];
  let collecting: string[] | undefined;
  let atStatementStart = true;
  let index = 0;

  const skipQuoted = (quote: string, backslashEscapes: boolean) => {
    index += 1;
    while (index < sql.length) {
      const character = sql[index];
      if (backslashEscapes && character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === quote) {
        if (sql[index] !== quote) return;
        index += 1;
      }
    }
  };

  while (index < sql.length) {
    const character = sql[index]!;
    const rest = sql.slice(index);
    if (rest.startsWith("--")) {
      const lineEnd = sql.indexOf("\n", index);
      index = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      // PostgreSQL のブロックコメントは入れ子にできる。
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (character === "'") {
      const previous = index > 0 ? sql[index - 1] : undefined;
      skipQuoted("'", previous === "E" || previous === "e");
      atStatementStart = false;
      collecting = undefined;
      continue;
    }
    if (character === '"') {
      skipQuoted('"', false);
      atStatementStart = false;
      collecting = undefined;
      continue;
    }
    const tag = dollarQuoteTag.exec(rest)?.[0];
    if (tag !== undefined) {
      const end = sql.indexOf(tag, index + tag.length);
      index = end === -1 ? sql.length : end + tag.length;
      atStatementStart = false;
      collecting = undefined;
      continue;
    }
    if (character === ";") {
      atStatementStart = true;
      collecting = undefined;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (identifierStart.test(character)) {
      let end = index + 1;
      while (end < sql.length && identifierPart.test(sql[end]!)) end += 1;
      const word = sql.slice(index, end).toLowerCase();
      index = end;
      if (atStatementStart) {
        collecting = [word];
        statements.push(collecting);
        atStatementStart = false;
      } else if (collecting !== undefined) {
        collecting.push(word);
        collecting = undefined;
      }
      continue;
    }
    atStatementStart = false;
    collecting = undefined;
    index += 1;
  }

  return statements;
};

const transactionControlWords = new Set([
  "begin",
  "commit",
  "rollback",
  "abort",
  "end",
]);

// migration の SQL が自分でトランザクションを閉じると、記録の insert や 55P03 の再試行が
// runner のトランザクションの外に出る。再試行すると、確定済みの文をもう一度流すことになる。
const controlsTransaction = (sql: string): boolean =>
  statementLeadingWords(sql).some(
    ([first, second]) =>
      (first !== undefined && transactionControlWords.has(first)) ||
      ((first === "start" || first === "prepare") && second === "transaction"),
  );

const assertMigrationKeepsRunnerBounds = (sql: string): void => {
  if (changesStatementTimeout.test(sql)) {
    throw new MigrationChangesStatementTimeoutError();
  }
  if (changesSessionSettings.test(sql)) {
    throw new MigrationChangesSessionSettingsError();
  }
  if (controlsTransaction(sql)) {
    throw new MigrationControlsTransactionError();
  }
};

type AppliedMigrationRow = QueryResultRow & MigrationState;

const readApplied = async (client: Pick<PoolClient, "query">) => {
  const result = await client.query<AppliedMigrationRow>(readAppliedSql);
  return result.rows;
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

// advisory lock を取る前に読むので、先行の migrator が流している途中のものも未適用に数える。
// その値は先行の残りの本数の上界になる。
const countUnappliedBeforeLock = async (
  client: Pick<PoolClient, "query">,
  local: readonly MigrationFile[],
): Promise<number> => {
  let applied: AppliedMigrationRow[];
  try {
    applied = await readApplied(client);
  } catch (error) {
    if (hasErrorCode(error, "42P01")) return local.length;
    throw error;
  }
  const appliedFilenames = new Set(applied.map(({ filename }) => filename));
  return local.filter(({ filename }) => !appliedFilenames.has(filename)).length;
};

const acquireAdvisoryLock = async (
  client: Pick<PoolClient, "query">,
  waitMillis: number,
  onLocked: () => void,
): Promise<void> => {
  // lock_timeout は advisory lock を含むすべての重量ロックの待ちに効く。セッション単位で
  // 設定し、成否にかかわらずすぐ戻して、各 migration には SET LOCAL の値だけを効かせる。
  await client.query(`set lock_timeout = ${waitMillis}`);
  await runWithCleanup(
    async () => {
      try {
        await client.query(
          "select pg_advisory_lock($1::integer, $2::integer)",
          advisoryLockKeys,
        );
        // reset が失敗しても unlock されるよう、取れた時点で記録する。
        onLocked();
      } catch (error) {
        // DDL の 55P03 と取り違えないよう、ここでは再試行せず専用のエラーにする。
        if (hasErrorCode(error, "55P03")) {
          throw new MigrationLockWaitExceededError();
        }
        throw error;
      }
    },
    async () => {
      await client.query("reset lock_timeout");
    },
  );
};

const runMigrationTransaction = async (
  client: Pick<PoolClient, "query">,
  migration: MigrationFile,
): Promise<void> => {
  await client.query("begin");
  let committed = false;
  await runWithCleanup(
    async () => {
      await client.query(`set local lock_timeout = '${migrationLockTimeout}'`);
      await client.query(
        `set local statement_timeout = '${migrationStatementTimeout}'`,
      );
      await client.query(migration.sql);
      await client.query(
        "insert into starter_migrations (filename, checksum) values ($1, $2)",
        [migration.filename, migration.checksum],
      );
      await client.query("commit");
      committed = true;
    },
    async () => {
      if (!committed) {
        await client.query("rollback");
      }
    },
  );
};

const applyMigrationWithRetry = async (
  client: Pick<PoolClient, "query">,
  migration: MigrationFile,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runMigrationTransaction(client, migration);
      return;
    } catch (error) {
      if (hasErrorCode(error, "55P03")) {
        if (attempt >= maxMigrationAttempts) {
          throw new MigrationLockRetriesExhaustedError(maxMigrationAttempts);
        }
        await sleep(retryBackoffBaseMillis * 2 ** (attempt - 1));
        continue;
      }
      if (hasErrorCode(error, "57014")) {
        throw new MigrationStatementTimeoutError();
      }
      throw error;
    }
  }
};

export const applyMigrations = async ({
  pool,
  migrationsDirectory = defaultMigrationsDirectory,
  advisoryLockWaitPerMigrationMillis = defaultAdvisoryLockWaitPerMigrationMillis,
  sleep = defaultSleep,
}: {
  pool: Pool;
  migrationsDirectory?: string;
  /** 統合テストで W を短くするための差し替え口。本番では既定の 10 分を使う。 */
  advisoryLockWaitPerMigrationMillis?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{ applied: string[] }> => {
  if (
    !Number.isInteger(advisoryLockWaitPerMigrationMillis) ||
    advisoryLockWaitPerMigrationMillis < 1
  ) {
    throw new Error(
      "advisoryLockWaitPerMigrationMillis must be a positive integer",
    );
  }
  const local = await loadMigrationFiles(migrationsDirectory);
  for (const { sql } of local) {
    assertMigrationKeepsRunnerBounds(sql);
  }
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;

  return runWithCleanup(
    async () => {
      const unappliedBound = await countUnappliedBeforeLock(client, local);
      // 未適用が 0 本でも、先行がちょうど最後の 1 本を流している最中かもしれない。
      await acquireAdvisoryLock(
        client,
        Math.max(1, unappliedBound) * advisoryLockWaitPerMigrationMillis,
        () => {
          locked = true;
        },
      );
      await client.query(`
        create table if not exists starter_migrations (
          filename text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);
      const pending = compareMigrationState(local, await readApplied(client));

      for (const migration of pending) {
        await applyMigrationWithRetry(client, migration, sleep);
        applied.push(migration.filename);
      }

      return { applied };
    },
    async () => {
      await runWithCleanup(
        async () => {
          if (!locked) return;
          await client.query(
            "select pg_advisory_unlock($1::integer, $2::integer)",
            advisoryLockKeys,
          );
        },
        () => {
          client.release();
          return Promise.resolve();
        },
      );
    },
  );
};

export const assertMigrationsCurrent = async (
  pool: Pool,
  migrationsDirectory: string = defaultMigrationsDirectory,
): Promise<void> => {
  const local = await loadMigrationFiles(migrationsDirectory);
  const appliedState = await (async () => {
    try {
      return { applied: await readApplied(pool), status: "available" } as const;
    } catch (error) {
      if (hasErrorCode(error, "42P01")) {
        return { status: "missing" } as const;
      }
      return { status: "unavailable" } as const;
    }
  })();

  if (appliedState.status === "missing") {
    throw new Error(
      `Database migrations are not initialized. Run "${migrateCommand}".`,
    );
  }
  if (appliedState.status === "unavailable") {
    throw new Error(
      `Unable to verify database migrations. Check database connectivity and run "${migrateCommand}".`,
    );
  }

  const pending = compareMigrationState(local, appliedState.applied);
  if (pending.length > 0) {
    throw new Error(
      `Database migrations are pending: ${pending.map(({ filename }) => filename).join(", ")}. Run "${migrateCommand}".`,
    );
  }
};
