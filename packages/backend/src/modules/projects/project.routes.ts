import {
  archiveProjectInputSchema,
  createProjectInputSchema,
  listProjectsResponseSchema,
  projectDtoSchema,
  projectIdSchema,
  updateProjectInputSchema,
} from "@starter/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app/app-env.js";
import { validate } from "../../app/validation-hook.js";
import type { CreateProject } from "./create-project.js";
import type { Project } from "./project.model.js";
import type { ArchiveProject } from "./archive-project.js";
import type { GetProject } from "./get-project.js";
import type { ListProjects } from "./list-projects.js";
import type { UpdateProject } from "./update-project.js";

// パスパラメータは URL の一部でしかないが、zValidator の param はオブジェクトを要求する。
// キーを projectId にすることで、失敗時の fieldErrors のキーが本文検証と揃う。
const projectPathSchema = z.object({ projectId: projectIdSchema });

// projectDtoSchema は未知のキーを落とすので、ownerUserId と createdAt は応答に出ない。
// 所有者の ID を出すと利用者 ID を列挙できてしまう。
const toProjectDto = (project: Project) =>
  projectDtoSchema.parse({
    ...project,
    updatedAt: project.updatedAt.toISOString(),
  });

export const createProjectRoutes = ({
  createProject,
  archiveProject,
  getProject,
  listProjects,
  updateProject,
}: {
  createProject: CreateProject;
  archiveProject: ArchiveProject;
  getProject: GetProject;
  listProjects: ListProjects;
  updateProject: UpdateProject;
}) => {
  const routes = new Hono<AppEnv>();

  return routes
    .post("/", validate("json", createProjectInputSchema), async (context) => {
      // actor は本文より後に置き、本文のキーで上書きされないようにする。
      const project = await createProject({
        ...context.req.valid("json"),
        actor: context.get("actor"),
      });
      return context.json(toProjectDto(project), 201, {
        Location: `/api/projects/${encodeURIComponent(project.id)}`,
      });
    })
    .get("/", async (context) => {
      const projects = await listProjects({ actor: context.get("actor") });
      const body = listProjectsResponseSchema.parse({
        items: projects.map(toProjectDto),
      });

      return context.json(body, 200);
    })
    .get(
      "/:projectId",
      validate("param", projectPathSchema),
      async (context) => {
        const project = await getProject({
          actor: context.get("actor"),
          id: context.req.valid("param").projectId,
        });
        return context.json(toProjectDto(project), 200);
      },
    )
    .patch(
      "/:projectId",
      validate("param", projectPathSchema),
      validate("json", updateProjectInputSchema),
      async (context) => {
        const project = await updateProject({
          ...context.req.valid("json"),
          actor: context.get("actor"),
          id: context.req.valid("param").projectId,
        });
        return context.json(toProjectDto(project), 200);
      },
    )
    .post(
      "/:projectId/archive",
      validate("param", projectPathSchema),
      validate("json", archiveProjectInputSchema),
      async (context) => {
        const project = await archiveProject({
          ...context.req.valid("json"),
          actor: context.get("actor"),
          id: context.req.valid("param").projectId,
        });
        return context.json(toProjectDto(project), 200);
      },
    );
};
