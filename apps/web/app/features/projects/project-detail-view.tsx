import type { Problem, ProjectDto } from "@starter/contracts";
import type { ChangeEvent, ElementType } from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
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
    <main>
      <Link to="/projects">Projects に戻る</Link>
      <h1>{name}</h1>
      <p>
        <span className="project-status">{status}</span>
      </p>
      <p>Version: {project.version}</p>
      <time dateTime={project.updatedAt}>{project.updatedAt}</time>
      {status === "active" ? (
        <>
          <FormComponent
            className="project-form project-detail-form"
            method="post"
          >
            <input name="intent" type="hidden" value="update" />
            <input
              name="version"
              type="hidden"
              value={nameDraft?.version ?? project.version}
            />
            <label htmlFor="project-name">Project name</label>
            <input
              aria-describedby={projectMutationErrorId(fieldErrors, problem)}
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
            <button disabled={pending} type="submit">
              Save changes
            </button>
          </FormComponent>
          {archiveConfirmationVisible ? (
            <FormComponent
              className="project-archive-confirmation"
              method="post"
            >
              <input name="intent" type="hidden" value="archive" />
              <input name="version" type="hidden" value={project.version} />
              <p role="alert">Archiving cannot be undone.</p>
              <ProjectMutationError
                fieldErrors={fieldErrors}
                identified={false}
                problem={problem}
              />
              <button disabled={pending} type="submit">
                Confirm archive
              </button>
              <button
                disabled={pending}
                onClick={() => setArchiveConfirmationVisible(false)}
                type="button"
              >
                Cancel
              </button>
            </FormComponent>
          ) : (
            <button
              className="project-archive-button"
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
