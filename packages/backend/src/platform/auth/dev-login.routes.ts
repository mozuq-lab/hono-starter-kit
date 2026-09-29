import { Hono } from "hono";
import type { AppEnv } from "../../app/app-env.js";
import { getDevIdentity } from "./dev-identity.js";
import type { EstablishSession } from "./establish-session.js";
import { resolveReturnTo } from "./return-to.js";
import {
  getSessionCookie,
  setSessionCookie,
  type SessionCookieConfig,
} from "./session-cookie.js";

export const createDevLoginRoutes = ({
  establishSession,
  sessionCookie,
}: {
  establishSession: EstablishSession;
  sessionCookie: SessionCookieConfig;
}) => {
  const routes = new Hono<AppEnv>();

  return routes
    .get("/login", async (context) => {
      context.header("Cache-Control", "no-store");
      const previousSessionId = getSessionCookie(context, sessionCookie);
      const { sessionId } = await establishSession({
        identity: getDevIdentity(),
        ...(previousSessionId === undefined ? {} : { previousSessionId }),
      });
      setSessionCookie(context, sessionCookie, sessionId);
      return context.redirect(
        resolveReturnTo(context.req.query("returnTo")),
        303,
      );
    })
    .get("/provider-logout", (context) => {
      context.header("Cache-Control", "no-store");
      return context.redirect("/login", 303);
    });
};
