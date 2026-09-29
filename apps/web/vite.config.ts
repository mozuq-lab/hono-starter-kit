import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, loadEnv } from "vite";

import { resolveApiPort } from "./api-port.js";

export const resolveApiProxyTarget = (
  environment: Record<string, string | undefined>,
) =>
  environment.API_PROXY_TARGET ??
  `http://127.0.0.1:${String(resolveApiPort(environment))}`;

export const createProxyConfig = (target: string) => ({
  "/api": target,
  "/auth": target,
});

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", "");

  return {
    plugins: [reactRouter()],
    server: {
      proxy: createProxyConfig(resolveApiProxyTarget(environment)),
    },
  };
});
