import { Hono, type Context } from "hono";
import type { AppEnv } from "../../app/app-env.js";
import type { BeginExternalLogin } from "./begin-external-login.js";
import type { CompleteExternalLogin } from "./complete-external-login.js";
import type { EstablishSession } from "./establish-session.js";
import {
  clearExternalLoginCookie,
  getExternalLoginCookie,
  setExternalLoginCookie,
  type ExternalLoginCookieConfig,
} from "./external-login-cookie.js";
import {
  getSessionCookie,
  setSessionCookie,
  type SessionCookieConfig,
} from "./session-cookie.js";

export type { ExternalLoginCookieConfig } from "./external-login-cookie.js";

const failureDestination = "/login?error=authentication_failed";

const fail = (context: Context<AppEnv>) =>
  context.redirect(failureDestination, 303);

export const createExternalLoginRoutes = ({
  beginExternalLogin,
  completeExternalLogin,
  establishSession,
  providerLogoutUrl,
  redirectUri,
  sessionCookie,
  transactionCookie,
}: {
  beginExternalLogin: BeginExternalLogin;
  completeExternalLogin: CompleteExternalLogin;
  establishSession: EstablishSession;
  providerLogoutUrl: string;
  redirectUri: string;
  sessionCookie: SessionCookieConfig;
  transactionCookie: ExternalLoginCookieConfig;
}) => {
  const routes = new Hono<AppEnv>();

  return routes
    .get("/login", async (context) => {
      context.header("Cache-Control", "no-store");
      const authorization = await beginExternalLogin({
        returnTo: context.req.query("returnTo"),
      });
      setExternalLoginCookie(context, transactionCookie, {
        nonce: authorization.nonce,
        verifier: authorization.verifier,
      });
      return context.redirect(authorization.authorizationUrl, 303);
    })
    .get("/callback", async (context) => {
      context.header("Cache-Control", "no-store");
      const cookie = getExternalLoginCookie(context, transactionCookie);
      clearExternalLoginCookie(context, transactionCookie);
      // TLS 終端後の受信 URL は内部 HTTP origin になる。公開 origin/path は設定だけから
      // 復元し、任意の Host / Forwarded ヘッダを token exchange の redirect URI に使わない。
      const callbackUrl = new URL(redirectUri);
      callbackUrl.search = new URL(context.req.url).search;
      const states = callbackUrl.searchParams.getAll("state");
      const codes = callbackUrl.searchParams.getAll("code");
      const errors = callbackUrl.searchParams.getAll("error");
      const hasCode = codes.length === 1 && codes[0] !== "";
      const hasError = errors.length === 1 && errors[0] !== "";
      if (
        cookie === undefined ||
        states.length !== 1 ||
        states[0] === "" ||
        hasCode === hasError ||
        (!hasCode && codes.length !== 0) ||
        (!hasError && errors.length !== 0)
      ) {
        return fail(context);
      }

      try {
        const completed = await completeExternalLogin({
          callbackUrl,
          state: states[0]!,
          nonce: cookie.nonce,
          verifier: cookie.verifier,
        });
        if (hasError) return fail(context);
        const previousSessionId = getSessionCookie(context, sessionCookie);
        const { sessionId } = await establishSession({
          identity: completed.identity,
          ...(previousSessionId === undefined ? {} : { previousSessionId }),
        });
        setSessionCookie(context, sessionCookie, sessionId);
        return context.redirect(completed.returnTo, 303);
      } catch {
        return fail(context);
      }
    })
    .get("/provider-logout", (context) => {
      context.header("Cache-Control", "no-store");
      return context.redirect(providerLogoutUrl, 303);
    });
};
