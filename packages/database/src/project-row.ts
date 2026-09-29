import type { Project } from "@starter/backend";
import type { Selectable } from "kysely";
import type { ProjectsTable } from "./database.types.js";

type ProjectRow = Pick<
  Selectable<ProjectsTable>,
  | "id"
  | "owner_user_id"
  | "name"
  | "status"
  | "version"
  | "created_at"
  | "updated_at"
>;

/** repository が select・returning する列。toProject が読む列と一致させる。 */
export const projectColumns = [
  "id",
  "owner_user_id",
  "name",
  "status",
  "version",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof ProjectRow)[];

const toValidDate = (value: unknown, column: string): Date => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`projects.${column} must be a valid Date`);
  }
  return new Date(value);
};

export const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  status: row.status,
  version: row.version,
  createdAt: toValidDate(row.created_at, "created_at"),
  updatedAt: toValidDate(row.updated_at, "updated_at"),
});
