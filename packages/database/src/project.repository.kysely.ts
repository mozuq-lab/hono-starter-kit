import type { Project, ProjectRepository } from "@starter/backend";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "./database.types.js";
import { projectColumns, toProject } from "./project-row.js";

// どのクエリも owner_user_id で絞る。他人の行は「存在しない」ときと同じ結果になり、
// use case が PROJECT_NOT_FOUND に落とす。
export class KyselyProjectRepository implements ProjectRepository {
  constructor(private readonly db: Kysely<Database> | Transaction<Database>) {}

  async list(input: { ownerUserId: string }): Promise<readonly Project[]> {
    // index (owner_user_id, created_at desc, id desc) を並べ替えなしで読む。id は同時刻の行の並びを
    // 決定的にするための補助キー。
    const rows = await this.db
      .selectFrom("projects")
      .select(projectColumns)
      .where("owner_user_id", "=", input.ownerUserId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(toProject);
  }

  async findById(input: {
    id: string;
    ownerUserId: string;
  }): Promise<Project | undefined> {
    const row = await this.db
      .selectFrom("projects")
      .select(projectColumns)
      .where("id", "=", input.id)
      .where("owner_user_id", "=", input.ownerUserId)
      .executeTakeFirst();
    return row === undefined ? undefined : toProject(row);
  }

  async create(project: Project): Promise<Project> {
    const row = await this.db
      .insertInto("projects")
      .values({
        id: project.id,
        owner_user_id: project.ownerUserId,
        name: project.name,
        status: project.status,
        version: project.version,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      })
      .returning(projectColumns)
      .executeTakeFirstOrThrow();
    return toProject(row);
  }

  async update(input: {
    id: string;
    ownerUserId: string;
    name: string;
    expectedVersion: number;
    updatedAt: Date;
  }): Promise<Project | undefined> {
    const row = await this.db
      .updateTable("projects")
      .set(({ eb }) => ({
        name: input.name,
        updated_at: input.updatedAt,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", input.id)
      .where("owner_user_id", "=", input.ownerUserId)
      .where("status", "=", "active")
      .where("version", "=", input.expectedVersion)
      .returning(projectColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toProject(row);
  }

  async archive(input: {
    id: string;
    ownerUserId: string;
    expectedVersion: number;
    updatedAt: Date;
  }): Promise<Project | undefined> {
    const row = await this.db
      .updateTable("projects")
      .set(({ eb }) => ({
        status: "archived",
        updated_at: input.updatedAt,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", input.id)
      .where("owner_user_id", "=", input.ownerUserId)
      .where("status", "=", "active")
      .where("version", "=", input.expectedVersion)
      .returning(projectColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toProject(row);
  }
}
