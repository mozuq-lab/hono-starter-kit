import { platformProblemTypes } from "./problem.contract.js";
import { projectProblemTypes } from "../projects/project.contract.js";

// 合成を problem.contract.ts で行わないのは、projects 側がプラットフォームのコードを
// import するため。同じファイルで合成すると errors → projects → errors の循環になる。

/**
 * この契約が持つ Problem type の URI（全モジュールの合成）。送る側と受け取る側の
 * 両方がここから読むので、URI をパッケージ境界をまたいで書き写す必要がない。
 *
 * モジュールを足すときは、そのモジュールの `*ProblemTypes` をここに加える。
 */
export const problemTypes = {
  ...platformProblemTypes,
  ...projectProblemTypes,
} as const;

/** この契約が知っているエラーコード。{@link problemTypes} のキー。 */
export type ProblemCode = keyof typeof problemTypes;

/**
 * 受け取った `code` がこの契約の知るコードかを判定する。
 *
 * 新しいサーバに古いクライアントがぶつかっても壊れないよう、`problemSchema` 側の
 * `code` は任意の文字列を通す。{@link ProblemCode} へ絞り込む前に必ずこのガードを通し、
 * 分岐には既定の枝を残すこと。
 */
export const isKnownProblemCode = (code: string): code is ProblemCode =>
  Object.hasOwn(problemTypes, code);
