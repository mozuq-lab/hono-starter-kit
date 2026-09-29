import { createAuthClient, createProjectsClient } from "@starter/api-client";

const clientOptions = {
  baseUrl: globalThis.location?.origin ?? "http://127.0.0.1:5173",
  fetch: globalThis.fetch.bind(globalThis),
};

export const projectsClient = createProjectsClient(clientOptions);
export const authClient = createAuthClient(clientOptions);
