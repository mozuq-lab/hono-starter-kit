import type { Problem } from "@starter/contracts";
import type { ElementType, FormEvent } from "react";
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
    <main>
      <h1>Create Project</h1>
      <FormComponent className="project-form" method="post" onSubmit={submit}>
        <label htmlFor="project-name">Project name</label>
        <input
          aria-describedby={projectMutationErrorId(fieldErrors, problem)}
          id="project-name"
          maxLength={projectNameMaxLength}
          name="name"
          required
        />
        <ProjectMutationError fieldErrors={fieldErrors} problem={problem} />
        <button disabled={pending} type="submit">
          Create Project
        </button>
      </FormComponent>
    </main>
  );
}
