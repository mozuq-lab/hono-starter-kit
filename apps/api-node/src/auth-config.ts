import type { SessionCookieConfig, SessionPolicy } from "@starter/backend";
import { isLoopbackHost } from "./loopback-host.js";
import {
  resolveNodeEnvironment,
  type NodeEnvironment,
} from "./node-environment.js";
import {
  resolveLogoutRedirectParameter,
  resolveOidcTransportSecurity,
  resolveOidcUrl,
  resolveRequiredValue,
  resolveTransactionTtlSeconds,
  type OidcLogoutRedirectParameter,
} from "./oidc-config.js";
import { RedactedSecret } from "./redacted-secret.js";
import {
  resolveSessionCookie,
  resolveSessionPolicy,
  resolveTransactionCookie,
  type OidcTransactionCookieConfig,
} from "./session-policy-config.js";

const defaultAppOrigin = "http://127.0.0.1:5173";

type AuthEnvironment = {
  NODE_ENV?: string | undefined;
  AUTH_PROVIDER?: string | undefined;
  APP_ORIGIN?: string | undefined;
  OIDC_ISSUER?: string | undefined;
  OIDC_CLIENT_ID?: string | undefined;
  OIDC_LOGOUT_ENDPOINT?: string | undefined;
  OIDC_LOGOUT_REDIRECT_PARAMETER?: string | undefined;
  OIDC_CLIENT_SECRET?: string | undefined;
  OIDC_LOGIN_TRANSACTION_TTL_SECONDS?: string | undefined;
  SESSION_ABSOLUTE_TTL_SECONDS?: string | undefined;
  SESSION_IDLE_TTL_SECONDS?: string | undefined;
  SESSION_TOUCH_INTERVAL_SECONDS?: string | undefined;
};

export type { OidcLogoutRedirectParameter };

export type AuthConfigBase = {
  appOrigin: string;
  policy: SessionPolicy;
  cookie: SessionCookieConfig;
};

export type DevAuthConfig = AuthConfigBase & { provider: "dev" };

/**
 * token endpoint でのクライアント認証。既定は public client（`none`）で、
 * `OIDC_CLIENT_SECRET` があるときだけ `client_secret_basic` にする。PKCE・state・nonce は
 * どちらでも必須のまま。
 */
export type OidcClientAuthentication =
  | { method: "none" }
  | { method: "client_secret_basic"; secret: RedactedSecret };

export type OidcAuthConfig = AuthConfigBase & {
  provider: "oidc";
  transactionCookie: OidcTransactionCookieConfig;
  transactionTtlMs: number;
  oidc: {
    issuer: string;
    clientId: string;
    clientAuthentication: OidcClientAuthentication;
    logoutEndpoint: string;
    logoutRedirectParameter: OidcLogoutRedirectParameter;
    redirectUri: string;
    postLogoutRedirectUri: string;
  };
};

export type AuthConfig = DevAuthConfig | OidcAuthConfig;

const resolveProvider = (
  environment: NodeEnvironment,
  value: string | undefined,
): "dev" | "oidc" => {
  const provider = value?.trim() || "dev";

  if (environment === "production" && provider !== "oidc") {
    throw new Error(
      "AUTH_PROVIDER must select an implemented non-Dev provider in production",
    );
  }
  if (provider !== "dev" && provider !== "oidc") {
    throw new Error("AUTH_PROVIDER must be dev or oidc");
  }

  return provider;
};

const invalidAppOrigin = () =>
  new Error(
    "APP_ORIGIN must be an HTTP(S) origin without credentials, path, query, or hash",
  );

const resolveAppOrigin = (value: string | undefined): string => {
  let url: URL;
  try {
    url = new URL(value?.trim() || defaultAppOrigin);
  } catch {
    throw invalidAppOrigin();
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalidAppOrigin();
  }

  return url.origin;
};

// エラーメッセージに値を含めない。前後の空白・改行を trim して受け入れず拒否するのは、
// ファイルから Secrets Manager に登録すると末尾に改行が入りやすく、そのまま通すと起動は
// 成功してログイン時に初めて invalid_client になるため。trim して使うと、IdP に登録した
// 値と食い違っていても気づけない。
const resolveClientAuthentication = (
  value: string | undefined,
): OidcClientAuthentication => {
  if (value === undefined) return { method: "none" };
  if (value.trim() === "") {
    throw new Error("OIDC_CLIENT_SECRET must not be empty");
  }
  if (value !== value.trim()) {
    throw new Error(
      "OIDC_CLIENT_SECRET must not have leading or trailing whitespace",
    );
  }
  return { method: "client_secret_basic", secret: new RedactedSecret(value) };
};

export const resolveAuthConfig = (environment: AuthEnvironment): AuthConfig => {
  const nodeEnvironment = resolveNodeEnvironment(environment.NODE_ENV);
  const provider = resolveProvider(nodeEnvironment, environment.AUTH_PROVIDER);
  const appOrigin = resolveAppOrigin(environment.APP_ORIGIN);
  const { absoluteTtlSeconds, policy } = resolveSessionPolicy(environment);
  const base = { appOrigin, policy };

  if (provider === "dev") {
    // Dev プロバイダは OIDC URL を持たないので、実スキームの判定材料は APP_ORIGIN だけになる。
    // OIDC 側と同じ境界を敷く。ここを緩めると、到達可能なホストへ非 Secure な
    // セッション Cookie を平文で送る構成が通ってしまう。
    const appUrl = new URL(appOrigin);
    const secure = appUrl.protocol === "https:";
    if (!secure && !isLoopbackHost(appUrl.hostname)) {
      throw new Error(
        "APP_ORIGIN HTTP URLs require loopback hosts outside production",
      );
    }
    return {
      provider,
      ...base,
      cookie: resolveSessionCookie({
        secure,
        maxAgeSeconds: absoluteTtlSeconds,
      }),
    };
  }

  const clientAuthentication = resolveClientAuthentication(
    environment.OIDC_CLIENT_SECRET,
  );
  const issuer = resolveOidcUrl("OIDC_ISSUER", environment.OIDC_ISSUER);
  const logoutEndpoint = resolveOidcUrl(
    "OIDC_LOGOUT_ENDPOINT",
    environment.OIDC_LOGOUT_ENDPOINT,
  );
  const secure = resolveOidcTransportSecurity({
    nodeEnvironment,
    appOrigin,
    issuer: issuer.url,
    logoutEndpoint: logoutEndpoint.url,
  });
  const transactionTtlSeconds = resolveTransactionTtlSeconds(
    environment.OIDC_LOGIN_TRANSACTION_TTL_SECONDS,
  );

  return {
    ...base,
    provider,
    cookie: resolveSessionCookie({ secure, maxAgeSeconds: absoluteTtlSeconds }),
    transactionCookie: resolveTransactionCookie({
      secure,
      maxAgeSeconds: transactionTtlSeconds,
    }),
    transactionTtlMs: transactionTtlSeconds * 1000,
    oidc: {
      issuer: issuer.value,
      clientId: resolveRequiredValue(
        "OIDC_CLIENT_ID",
        environment.OIDC_CLIENT_ID,
      ),
      clientAuthentication,
      logoutEndpoint: logoutEndpoint.value,
      logoutRedirectParameter: resolveLogoutRedirectParameter(
        environment.OIDC_LOGOUT_REDIRECT_PARAMETER,
      ),
      redirectUri: new URL("/auth/callback", appOrigin).toString(),
      postLogoutRedirectUri: new URL("/login", appOrigin).toString(),
    },
  };
};
