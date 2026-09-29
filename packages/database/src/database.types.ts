import type { Project } from "@starter/backend";
import type { ColumnType, Generated } from "kysely";

export type ProjectsTable = {
  id: string;
  owner_user_id: string;
  name: string;
  status: Project["status"];
  version: number;
  created_at: ColumnType<Date, Date | string, Date | string>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
};

export type UsersTable = {
  id: string;
  email: string | null;
  display_name: string | null;
  roles: string[];
  created_at: ColumnType<Date, Date | string, Date | string>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
};

export type UserIdentitiesTable = {
  issuer: string;
  subject: string;
  provider: string;
  user_id: string;
  created_at: ColumnType<Date, Date | string, Date | string>;
  last_authenticated_at: ColumnType<Date, Date | string, Date | string>;
};

export type SessionsTable = {
  id_hash: string;
  user_id: string;
  absolute_expires_at: ColumnType<Date, Date | string, Date | string>;
  idle_expires_at: ColumnType<Date, Date | string, Date | string>;
  created_at: ColumnType<Date, Date | string, Date | string>;
  last_accessed_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  provider_session_id: string | null;
};

export type ExternalLoginTransactionsTable = {
  state_hash: string;
  nonce_hash: string;
  verifier_hash: string;
  return_to: string;
  created_at: ColumnType<Date, Date | string, Date | string>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
};

export type StarterMigrationsTable = {
  filename: string;
  checksum: string;
  applied_at: Generated<Date>;
};

export type Database = {
  external_login_transactions: ExternalLoginTransactionsTable;
  projects: ProjectsTable;
  sessions: SessionsTable;
  starter_migrations: StarterMigrationsTable;
  user_identities: UserIdentitiesTable;
  users: UsersTable;
};
