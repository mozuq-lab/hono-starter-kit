import type { Project } from "./project.model.js";

// 所有者の絞り込みは repository のクエリで行う。一覧は SQL で絞るしかないので、取得と更新も
// 同じ場所にそろえる。他人の Project は「存在しない」ときと同じく undefined を返す。
export interface ProjectRepository {
  /** 作成日時の新しい順。同時刻なら id の降順。 */
  list(input: { ownerUserId: string }): Promise<readonly Project[]>;
  findById(input: {
    id: string;
    ownerUserId: string;
  }): Promise<Project | undefined>;
  create(project: Project): Promise<Project>;
  update(input: {
    id: string;
    ownerUserId: string;
    name: string;
    expectedVersion: number;
    updatedAt: Date;
  }): Promise<Project | undefined>;
  archive(input: {
    id: string;
    ownerUserId: string;
    expectedVersion: number;
    updatedAt: Date;
  }): Promise<Project | undefined>;
}
