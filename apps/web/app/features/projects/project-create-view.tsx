import type { Problem } from "@starter/contracts";
import type { ElementType, FormEvent } from "react";
import {
  fieldLabelClass,
  pageMainClass,
  pageTitleClass,
  primaryButtonClass,
  textInputClass,
} from "../../components/ui-classes.js";
import {
  ProjectMutationError,
  projectMutationErrorId,
  projectNameMaxLength,
} from "./project-mutation-error.js";

export function ProjectCreateView({
  fieldErrors,
  FormComponent = "form",
  onSubmit,
  pending = false,
  problem,
}: {
  fieldErrors?: Record<string, string[]> | undefined;
  FormComponent?: ElementType;
  onSubmit?: ((name: string) => void) | undefined;
  pending?: boolean | undefined;
  problem?: Problem | undefined;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (onSubmit === undefined) return;
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("name");
    onSubmit(typeof value === "string" ? value : "");
  };

  return (
    <main className={pageMainClass}>
      <h1 className={pageTitleClass}>Create Project</h1>
      <FormComponent
        className="grid gap-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        method="post"
        onSubmit={submit}
      >
        <label className={fieldLabelClass} htmlFor="project-name">
          Project name
        </label>
        <input
          aria-describedby={projectMutationErrorId(fieldErrors, problem)}
          className={textInputClass}
          id="project-name"
          maxLength={projectNameMaxLength}
          name="name"
          required
        />
        <ProjectMutationError fieldErrors={fieldErrors} problem={problem} />
        <button className={primaryButtonClass} disabled={pending} type="submit">
          Create Project
        </button>
      </FormComponent>
    </main>
  );
}
