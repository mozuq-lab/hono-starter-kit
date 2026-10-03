import { Hono, type Context } from "hono";
import type { AppEnv } from "../../app/app-env.js";
import {
  ignoreSuppressedError,
  type ReportSuppressedError,
} from "../errors/report-suppressed-error.js";
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

// 例外ではない拒否も記録に載せるための印。理由は operation で区別し、クエリや Cookie の値、
// IdP が返したエラーコードは持たせない（どれも外から送り込める値）。
class ExternalLoginCallbackRejected extends Error {
  override readonly name = "ExternalLoginCallbackRejected";
}

// 応答はどの失敗でも同じ 303 にして理由を外へ見せないが、運用者にはクライアントの設定誤り、
// CloudFront 経由で取引用 Cookie が届かない、IdP や DB に届かない、を見分けられるようにする。
const callbackOperation = "auth.external-login-callback";

export const createExternalLoginRoutes = ({
  beginExternalLogin,
  completeExternalLogin,
  establishSession,
  providerLogoutUrl,
  redirectUri,
  reportSuppressedError = ignoreSuppressedError,
  sessionCookie,
  transactionCookie,
}: {
  beginExternalLogin: BeginExternalLogin;
  completeExternalLogin: CompleteExternalLogin;
  establishSession: EstablishSession;
  providerLogoutUrl: string;
  redirectUri: string;
  reportSuppressedError?: ReportSuppressedError;
  sessionCookie: SessionCookieConfig;
  transactionCookie: ExternalLoginCookieConfig;
}) => {
  const routes = new Hono<AppEnv>();
  const reject = (context: Context<AppEnv>, reason: string) => {
    reportSuppressedError({
      operation: `${callbackOperation}.${reason}`,
      error: new ExternalLoginCallbackRejected(reason),
    });
    return fail(context);
  };

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
      if (cookie === undefined) return reject(context, "missing-transaction");
      if (
        states.length !== 1 ||
        states[0] === "" ||
        hasCode === hasError ||
        (!hasCode && codes.length !== 0) ||
        (!hasError && errors.length !== 0)
      ) {
        return reject(context, "invalid-query");
      }

      try {
        const completed = await completeExternalLogin({
          callbackUrl,
          state: states[0]!,
          nonce: cookie.nonce,
          verifier: cookie.verifier,
        });
        if (hasError) return reject(context, "provider-error");
        const previousSessionId = getSessionCookie(context, sessionCookie);
        const { sessionId } = await establishSession({
          identity: completed.identity,
          ...(previousSessionId === undefined ? {} : { previousSessionId }),
        });
        setSessionCookie(context, sessionCookie, sessionId);
        return context.redirect(completed.returnTo, 303);
      } catch (error) {
        reportSuppressedError({ operation: callbackOperation, error });
        return fail(context);
      }
    })
    .get("/provider-logout", (context) => {
      context.header("Cache-Control", "no-store");
      return context.redirect(providerLogoutUrl, 303);
    });
};
