import { z } from "zod";
import {
  platformProblemTypes,
  type PlatformProblemCode,
} from "../errors/problem.contract.js";

/**
 * Project の状態。`archived` は終端で、`active` へは戻せない。
 */
export const projectStatusSchema = z.enum(["active", "archived"]);

/**
 * Project の識別子。サーバが採番した不透明な文字列として扱い、
 * 形式に依存した解析をしないこと。
 */
export const projectIdSchema = z.string().min(1).max(200);

/**
 * 楽観ロックのバージョン。更新のたびにサーバが 1 から増やす。
 * 更新・アーカイブでは読み取り時の値をそのまま送り返す必要があり、
 * 一致しなければ `PROJECT_VERSION_CONFLICT` が返る。
 */
export const projectVersionSchema = z.number().int().positive();

/** 入力の受け入れ上限。応答 DTO とクライアントの入力制限もここから導出する。 */
export const projectNameMaxLength = 100;

/**
 * Project 名の入力規則。前後の空白を落とした長さで検証するが、このスキーマ自体は
 * 値を変換しない。パースした結果には送った文字列がそのまま残る。
 *
 * 前後の空白はサーバが保存前に落とすので、応答に載る名前は送った文字列と一致しないことがある。
 * 画面の表示は入力値ではなく応答の {@link projectDtoSchema} 側を正とすること。
 */
export const projectNameSchema = z.string().superRefine((name, context) => {
  const length = name.trim().length;
  if (length < 1) {
    context.addIssue({ code: "custom", message: "Project name is required." });
  } else if (length > projectNameMaxLength) {
    context.addIssue({
      code: "custom",
      message: `Project name must be ${String(projectNameMaxLength)} characters or fewer.`,
    });
  }
});

/**
 * 応答に載る Project の表現。`name` は保存されている文字列（前後の空白を落としたもの）を
 * そのままの長さで検証する。`updatedAt` はオフセット付き ISO 8601 の文字列で、
 * `Date` は通らない。日時として扱うなら受け取り側でパースすること。
 */
export const projectDtoSchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1).max(projectNameMaxLength),
  status: projectStatusSchema,
  version: projectVersionSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

/** Project 作成の入力。識別子と初期バージョンはサーバが決める。 */
export const createProjectInputSchema = z.object({ name: projectNameSchema });

/**
 * Project 更新の入力。`version` は読み取った値をそのまま返すことで、
 * 別のクライアントの更新を上書きしていないことをサーバが確認する。
 */
export const updateProjectInputSchema = z.object({
  name: projectNameSchema,
  version: projectVersionSchema,
});

/** Project アーカイブの入力。更新と同じ楽観ロックが働く。 */
export const archiveProjectInputSchema = z.object({
  version: projectVersionSchema,
});

/**
 * Project 一覧の応答。要求した利用者の Project だけを、作成日時の新しい順
 * （同時刻なら `id` の降順）で返す。並び順はサーバが決めるので、受け取り側は並べ替えない。
 * ページングを持たないので、増えたときはこの契約自体を変えることになる。
 */
export const listProjectsResponseSchema = z.object({
  items: z.array(projectDtoSchema),
});

/** 応答に載る Project。{@link projectDtoSchema} の推論型。 */
export type ProjectDto = z.infer<typeof projectDtoSchema>;
/** Project 作成の入力。{@link createProjectInputSchema} の推論型。 */
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
/** Project 更新の入力。{@link updateProjectInputSchema} の推論型。 */
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
/** Project アーカイブの入力。{@link archiveProjectInputSchema} の推論型。 */
export type ArchiveProjectInput = z.infer<typeof archiveProjectInputSchema>;
/** Project 一覧の応答。{@link listProjectsResponseSchema} の推論型。 */
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

/** Projects の API だけが返す Problem の type URI。 */
export const projectProblemTypes = {
  PROJECT_NOT_FOUND: "https://starter.local/problems/project-not-found",
  PROJECT_ARCHIVED: "https://starter.local/problems/project-archived",
  PROJECT_VERSION_CONFLICT:
    "https://starter.local/problems/project-version-conflict",
} as const satisfies Record<string, string>;

/**
 * Projects の API が返し得るエラーコード。プラットフォームのコードを含む。
 * 別のモジュールのコードは含まないので、Projects の画面はこれを網羅すればよい。
 */
export type ProjectProblemCode =
  PlatformProblemCode | keyof typeof projectProblemTypes;

/**
 * 受け取った `code` が Projects の API の返し得るコードかを判定する。
 * `isKnownProblemCode` と同じく、偽なら既定の表示に落とすこと。
 */
export const isProjectProblemCode = (
  code: string,
): code is ProjectProblemCode =>
  Object.hasOwn(platformProblemTypes, code) ||
  Object.hasOwn(projectProblemTypes, code);
