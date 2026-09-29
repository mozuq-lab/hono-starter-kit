import type {
  ExternalLoginTransaction,
  ExternalLoginTransactionStore,
} from "./external-login-transaction-store.js";

const cloneTransaction = (
  transaction: ExternalLoginTransaction,
): ExternalLoginTransaction => ({
  ...transaction,
  createdAt: new Date(transaction.createdAt.getTime()),
  expiresAt: new Date(transaction.expiresAt.getTime()),
});

export class InMemoryExternalLoginTransactionStore implements ExternalLoginTransactionStore {
  readonly #transactionsByStateHash = new Map<
    string,
    ExternalLoginTransaction
  >();

  create(input: ExternalLoginTransaction): Promise<void> {
    this.#transactionsByStateHash.set(input.stateHash, cloneTransaction(input));
    return Promise.resolve();
  }

  consume(input: {
    stateHash: string;
    nonceHash: string;
    verifierHash: string;
    now: Date;
  }): Promise<ExternalLoginTransaction | undefined> {
    const transaction = this.#transactionsByStateHash.get(input.stateHash);
    if (
      transaction === undefined ||
      transaction.nonceHash !== input.nonceHash ||
      transaction.verifierHash !== input.verifierHash
    ) {
      return Promise.resolve(undefined);
    }

    this.#transactionsByStateHash.delete(input.stateHash);
    if (transaction.expiresAt.getTime() <= input.now.getTime()) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve(cloneTransaction(transaction));
  }

  deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    let deleted = 0;
    for (const [stateHash, transaction] of this.#transactionsByStateHash) {
      if (deleted === input.limit) break;
      if (transaction.expiresAt.getTime() <= input.now.getTime()) {
        this.#transactionsByStateHash.delete(stateHash);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
