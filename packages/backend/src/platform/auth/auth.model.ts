export type VerifiedIdentity = {
  provider: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  roles: string[];
  providerSessionId?: string;
};

export type Actor = { userId: string; roles: string[] };

export type AuthenticatedUser = {
  id: string;
  email?: string;
  displayName?: string;
  roles: string[];
};

export type StoredAuthentication = {
  idHash: string;
  user: AuthenticatedUser;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  lastAccessedAt: Date;
  revokedAt?: Date;
};
