import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app/app-env.js";
import { problemResponse } from "../../app/problem.js";
import type { AuthenticateSession } from "./authenticate-session.js";
import {
  getSessionCookie,
  type SessionCookieConfig,
} from "./session-cookie.js";

export const createAuthenticationMiddleware = ({
  authenticateSession,
  sessionCookie,
}: {
  authenticateSession: AuthenticateSession;
  sessionCookie: SessionCookieConfig;
}): MiddlewareHandler<AppEnv> => {
  return async (context, next) => {
    context.header("Cache-Control", "no-store");
    const authentication = await authenticateSession(
      getSessionCookie(context, sessionCookie),
    );
    if (authentication === undefined) {
      return problemResponse(context, "UNAUTHENTICATED");
    }

    context.set("actor", {
      ...authentication.actor,
      roles: [...authentication.actor.roles],
    });
    context.set("authenticatedUser", {
      ...authentication.user,
      roles: [...authentication.user.roles],
    });
    await next();
  };
};
