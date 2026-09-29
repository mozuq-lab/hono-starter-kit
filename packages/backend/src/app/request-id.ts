import { trace, type Span } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app-env.js";

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export const annotateActiveSpanWithRequestId = (
  requestId: string,
  span: Pick<Span, "setAttribute"> | undefined = trace.getActiveSpan(),
) => {
  span?.setAttribute("request.id", requestId);
};

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const incomingRequestId = context.req.header("X-Request-Id");
  const requestId =
    incomingRequestId !== undefined && requestIdPattern.test(incomingRequestId)
      ? incomingRequestId
      : crypto.randomUUID();

  context.set("requestId", requestId);
  annotateActiveSpanWithRequestId(requestId);
  await next();
  context.header("X-Request-Id", requestId);
};
