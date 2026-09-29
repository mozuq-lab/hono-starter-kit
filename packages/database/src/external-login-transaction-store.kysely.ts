import type {
  ExternalLoginTransaction,
  ExternalLoginTransactionStore,
} from "@starter/backend";
import type { Kysely, Selectable } from "kysely";
import type {
  Database,
  ExternalLoginTransactionsTable,
} from "./database.types.js";

type ExternalLoginTransactionRow = Selectable<ExternalLoginTransactionsTable>;

const cloneDate = (date: Date): Date => new Date(date.getTime());

export const toExternalLoginTransaction = (
  row: ExternalLoginTransactionRow,
): ExternalLoginTransaction => ({
  stateHash: row.state_hash,
  nonceHash: row.nonce_hash,
  verifierHash: row.verifier_hash,
  returnTo: row.return_to,
  createdAt: cloneDate(row.created_at),
  expiresAt: cloneDate(row.expires_at),
});

export class KyselyExternalLoginTransactionStore implements ExternalLoginTransactionStore {
  constructor(private readonly database: Kysely<Database>) {}

  async create(input: ExternalLoginTransaction): Promise<void> {
    await this.database
      .insertInto("external_login_transactions")
      .values({
        state_hash: input.stateHash,
        nonce_hash: input.nonceHash,
        verifier_hash: input.verifierHash,
        return_to: input.returnTo,
        created_at: cloneDate(input.createdAt),
        expires_at: cloneDate(input.expiresAt),
      })
      .execute();
  }

  async consume(input: {
    stateHash: string;
    nonceHash: string;
    verifierHash: string;
    now: Date;
  }): Promise<ExternalLoginTransaction | undefined> {
    const row = await this.database
      .deleteFrom("external_login_transactions")
      .where("state_hash", "=", input.stateHash)
      .where("nonce_hash", "=", input.nonceHash)
      .where("verifier_hash", "=", input.verifierHash)
      .where("expires_at", ">", cloneDate(input.now))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toExternalLoginTransaction(row);
  }

  async deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    const result = await this.database
      .deleteFrom("external_login_transactions")
      .where("state_hash", "in", (expressionBuilder) =>
        expressionBuilder
          .selectFrom("external_login_transactions")
          .select("state_hash")
          .where("expires_at", "<=", cloneDate(input.now))
          .orderBy("expires_at", "asc")
          .limit(input.limit),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
