import { Hono } from "hono";
import type { AppEnv } from "../../app/app-env.js";
import type { RevokeSession } from "./revoke-session.js";
import {
  clearSessionCookie,
  getSessionCookie,
  type SessionCookieConfig,
} from "./session-cookie.js";

export const createSessionRoutes = ({
  revokeSession,
  sessionCookie,
}: {
  revokeSession: RevokeSession;
  sessionCookie: SessionCookieConfig;
}) => {
  const routes = new Hono<AppEnv>();

  return routes.post("/logout", async (context) => {
    context.header("Cache-Control", "no-store");
    await revokeSession(getSessionCookie(context, sessionCookie));
    clearSessionCookie(context, sessionCookie);
    return context.body(null, 204);
  });
};
