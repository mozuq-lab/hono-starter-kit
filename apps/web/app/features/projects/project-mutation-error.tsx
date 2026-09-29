import {
  isProjectProblemCode,
  projectNameMaxLength,
  type Problem,
  type ProjectProblemCode,
} from "@starter/contracts";
import { alertBoxClass, alertCodeClass } from "../../components/ui-classes.js";

export const projectNameErrorId = "project-name-error";
export const projectMutationProblemId = "project-mutation-problem";

// 入力欄の上限は、送信を実際に検証する入力スキーマと同じ定数から取る。
// 応答 DTO 側から取ると trim の有無で受理範囲がずれる。
export { projectNameMaxLength };

export const getNameErrors = (
  fieldErrors: Record<string, string[]> | undefined,
): string[] => fieldErrors?.name ?? [];

/**
 * 実際に描画される説明要素の id。`aria-describedby` を組み立てる側と
 * 描画する側が同じ優先順位を使うための単一の出どころ。
 */
export const projectMutationErrorId = (
  fieldErrors: Record<string, string[]> | undefined,
  problem: Problem | undefined,
): string | undefined => {
  if (getNameErrors(fieldErrors).length > 0) return projectNameErrorId;
  return problem === undefined ? undefined : projectMutationProblemId;
};

/**
 * Projects の API が返し得るコードは網羅的に分岐させる。プラットフォームか Projects の
 * コードが増えると `default` で型エラーになる。別モジュールのコードは対象外で、
 * 届いても既定の表示に落ちる。開発者向けの `problem.detail` はどの分岐でも表示しない。
 */
export const knownProblemMessage = (code: ProjectProblemCode): string => {
  switch (code) {
    case "PROJECT_VERSION_CONFLICT":
      return "Project was updated on the server.";
    case "PROJECT_ARCHIVED":
      return "Project is archived and cannot be updated.";
    case "PROJECT_NOT_FOUND":
      return "Project is no longer available.";
    case "VALIDATION_ERROR":
      return "The submitted values were rejected. Please review the form.";
    case "UNAUTHENTICATED":
      return "The session has expired. Please sign in again.";
    case "ORIGIN_NOT_ALLOWED":
      return "The request was blocked. Please reload the page and retry.";
    case "INTERNAL_ERROR":
      return "The request failed on the server. Please retry.";
    // 画面と API の版がずれたとき（デプロイ中など）に起きる。再読み込みで新しい画面を取り直す。
    case "NOT_FOUND":
      return "This action is not available. Please reload the page and retry.";
    case "PAYLOAD_TOO_LARGE":
      return "The submitted data is too large.";
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
};

/**
 * 同じ状態を複数のフォームへ同時に描画する画面があるため、`aria-describedby` が
 * 指す id を持つのは一箇所だけにする。id が重複すると参照が曖昧になり、
 * 読み上げられる要素と利用者が見ている要素がずれる。
 */
export function ProjectMutationError({
  fieldErrors,
  problem,
  identified = true,
  className = alertBoxClass,
}: {
  fieldErrors: Record<string, string[]> | undefined;
  problem?: Problem | undefined;
  identified?: boolean;
  className?: string;
}) {
  const nameErrors = getNameErrors(fieldErrors);

  if (nameErrors.length > 0) {
    return (
      <p
        className={className}
        id={identified ? projectNameErrorId : undefined}
        role="alert"
      >
        {nameErrors.join(" ")}
      </p>
    );
  }

  if (problem === undefined) return null;

  const problemId = identified ? projectMutationProblemId : undefined;

  if (isProjectProblemCode(problem.code)) {
    return (
      <p className={className} id={problemId} role="alert">
        {knownProblemMessage(problem.code)}
      </p>
    );
  }

  // 未知コードでも必ず何かを返す。文言は title のみ、詳細は出さない。
  return (
    <p className={className} id={problemId} role="alert">
      {problem.title}
      <span className="block font-mono text-xs text-red-700 dark:text-red-300">
        Request ID: <code className={alertCodeClass}>{problem.requestId}</code>
      </span>
    </p>
  );
}
