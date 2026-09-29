import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app/app-env.js";
import { problemResponse } from "../../app/problem.js";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const createOriginMiddleware = ({
  allowedOrigin,
}: {
  allowedOrigin: string;
}): MiddlewareHandler<AppEnv> => {
  return async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (
      unsafeMethods.has(context.req.method) &&
      context.req.header("Origin") !== allowedOrigin
    ) {
      return problemResponse(context, "ORIGIN_NOT_ALLOWED");
    }

    await next();
  };
};
