export type ExternalLoginTransaction = {
  stateHash: string;
  nonceHash: string;
  verifierHash: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
};

export interface ExternalLoginTransactionStore {
  create(input: ExternalLoginTransaction): Promise<void>;
  consume(input: {
    stateHash: string;
    nonceHash: string;
    verifierHash: string;
    now: Date;
  }): Promise<ExternalLoginTransaction | undefined>;
  deleteExpired(input: { now: Date; limit: 100 }): Promise<number>;
}
