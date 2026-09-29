import { ApiError } from "@starter/api-client";
import {
  Form,
  redirect,
  type ClientActionFunctionArgs,
  useActionData,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { ProjectCreateView } from "../features/projects/project-create-view.js";
import {
  submitProjectCreate,
  type ProjectMutationActionData,
} from "../features/projects/project-mutations.js";
import { ProjectsErrorView } from "../features/projects/projects-error-view.js";
import { queryClient } from "../lib/query-client.js";

export async function clientAction({ request }: ClientActionFunctionArgs) {
  const formData = await request.formData();
  const name = formData.get("name");

  const outcome = await submitProjectCreate(
    { client: queryClient, requestUrl: request.url },
    { name: typeof name === "string" ? name : "" },
  );

  return "rejected" in outcome
    ? outcome.rejected
    : redirect(`/projects/${encodeURIComponent(outcome.confirmed.id)}`);
}

export default function ProjectNewRoute() {
  const actionData = useActionData<ProjectMutationActionData>();
  const navigation = useNavigation();

  return (
    <ProjectCreateView
      fieldErrors={actionData?.fieldErrors}
      problem={actionData?.problem}
      FormComponent={Form}
      pending={navigation.state !== "idle"}
    />
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  return (
    <ProjectsErrorView
      requestId={requestId}
      onRetry={() => void navigate("/projects/new", { replace: true })}
    />
  );
}
