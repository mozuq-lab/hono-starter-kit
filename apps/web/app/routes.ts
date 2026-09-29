import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  layout("routes/authenticated-layout.tsx", [
    route("projects", "routes/projects.tsx"),
    route("projects/new", "routes/project-new.tsx"),
    route("projects/:projectId", "routes/project-detail.tsx"),
  ]),
] satisfies RouteConfig;
