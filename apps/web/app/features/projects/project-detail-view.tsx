import type { Problem, ProjectDto } from "@starter/contracts";
import type { ChangeEvent, ElementType } from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  dangerButtonClass,
  dangerOutlineButtonClass,
  fieldLabelClass,
  ghostButtonClass,
  pageMainClass,
  primaryButtonClass,
  statusBadgeClass,
  textInputClass,
} from "../../components/ui-classes.js";
import {
  ProjectMutationError,
  projectMutationErrorId,
  projectNameMaxLength,
} from "./project-mutation-error.js";

export function ProjectDetailView({
  project,
  fieldErrors,
  FormComponent = "form",
  pending = false,
  pendingFormData,
  problem,
}: {
  project: ProjectDto;
  fieldErrors?: Record<string, string[]> | undefined;
  FormComponent?: ElementType;
  pending?: boolean | undefined;
  pendingFormData?: FormData | undefined;
  problem?: Problem | undefined;
}) {
  const [archiveConfirmationVisible, setArchiveConfirmationVisible] =
    useState(false);
  const wasArchivePending = useRef(false);
  const pendingName = pendingFormData?.get("name");
  const archivePending =
    pending && pendingFormData?.get("intent") === "archive";
  const optimisticName =
    pending &&
    pendingFormData?.get("intent") === "update" &&
    typeof pendingName === "string"
      ? pendingName
      : undefined;
  const name =
    optimisticName === "" ? project.name : (optimisticName ?? project.name);
  const status = archivePending ? "archived" : project.status;

  // 再取得だけで version を進めると、古い下書きで他の更新を上書きしてしまう。
  const [nameDraft, setNameDraft] = useState<
    { name: string; version: number } | undefined
  >(undefined);
  const updatePending = optimisticName !== undefined;
  const wasUpdatePending = useRef(false);
  // 失敗判定を name フィールドの有無に依存させない。
  const mutationFailed =
    problem !== undefined ||
    Object.values(fieldErrors ?? {}).some((messages) => messages.length > 0);

  // ルートは :projectId が変わっても再マウントしないので、
  // 別 Project の下書きや確認状態を持ち越さないよう自分でリセットする。
  const [renderedProjectId, setRenderedProjectId] = useState(project.id);
  if (renderedProjectId !== project.id) {
    setRenderedProjectId(project.id);
    setNameDraft(undefined);
    setArchiveConfirmationVisible(false);
  }

  useEffect(() => {
    if (!archivePending && wasArchivePending.current) {
      setArchiveConfirmationVisible(false);
    }
    wasArchivePending.current = archivePending;
  }, [archivePending]);

  useEffect(() => {
    if (optimisticName !== undefined) {
      // 送信値を下書きに取り込み、失敗して idle に戻っても入力を残す。
      setNameDraft((current) => ({
        name: optimisticName,
        version: current?.version ?? project.version,
      }));
    } else if (wasUpdatePending.current && !mutationFailed) {
      // 成功したときだけサーバ確定値への追従に戻す。
      setNameDraft(undefined);
    } else if (
      wasUpdatePending.current &&
      problem?.code === "PROJECT_VERSION_CONFLICT"
    ) {
      // 競合を知らせた後の明示的な再試行は、取得し直した確定値を基準にする。
      setNameDraft((current) =>
        current === undefined
          ? undefined
          : { ...current, version: project.version },
      );
    }
    wasUpdatePending.current = updatePending;
  }, [
    updatePending,
    optimisticName,
    mutationFailed,
    problem?.code,
    project.version,
  ]);

  return (
    <main className={pageMainClass}>
      <Link
        className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 no-underline hover:underline dark:text-blue-400"
        to="/projects"
      >
        Projects に戻る
      </Link>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{name}</h1>
      <p className="mt-3">
        <span className={statusBadgeClass}>{status}</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
        <p>Version: {project.version}</p>
        <time dateTime={project.updatedAt}>{project.updatedAt}</time>
      </div>
      {status === "active" ? (
        <>
          <FormComponent
            className="mt-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            method="post"
          >
            <input name="intent" type="hidden" value="update" />
            <input
              name="version"
              type="hidden"
              value={nameDraft?.version ?? project.version}
            />
            <label className={fieldLabelClass} htmlFor="project-name">
              Project name
            </label>
            <input
              aria-describedby={projectMutationErrorId(fieldErrors, problem)}
              className={textInputClass}
              id="project-name"
              maxLength={projectNameMaxLength}
              name="name"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const name = event.target.value;
                setNameDraft((current) => ({
                  name,
                  version: current?.version ?? project.version,
                }));
              }}
              readOnly={pending}
              required
              value={nameDraft?.name ?? project.name}
            />
            <ProjectMutationError fieldErrors={fieldErrors} problem={problem} />
            <button
              className={primaryButtonClass}
              disabled={pending}
              type="submit"
            >
              Save changes
            </button>
          </FormComponent>
          {archiveConfirmationVisible ? (
            <FormComponent
              className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
              method="post"
            >
              <input name="intent" type="hidden" value="archive" />
              <input name="version" type="hidden" value={project.version} />
              <p
                className="basis-full text-sm font-semibold text-red-700 dark:text-red-300"
                role="alert"
              >
                Archiving cannot be undone.
              </p>
              <ProjectMutationError
                fieldErrors={fieldErrors}
                identified={false}
                problem={problem}
              />
              <button
                className={dangerButtonClass}
                disabled={pending}
                type="submit"
              >
                Confirm archive
              </button>
              <button
                className={ghostButtonClass}
                disabled={pending}
                onClick={() => setArchiveConfirmationVisible(false)}
                type="button"
              >
                Cancel
              </button>
            </FormComponent>
          ) : (
            <button
              className={`${dangerOutlineButtonClass} mt-6`}
              disabled={pending}
              onClick={() => setArchiveConfirmationVisible(true)}
              type="button"
            >
              Archive Project
            </button>
          )}
        </>
      ) : null}
    </main>
  );
}
