import type { NodeEnvironment } from "./node-environment.js";
import { isLoopbackHost } from "./loopback-host.js";
import { resolveSeconds } from "./session-policy-config.js";

export type OidcLogoutRedirectParameter =
  "logout_uri" | "post_logout_redirect_uri";

export type ResolvedOidcUrl = { value: string; url: URL };

const invalidOidcUrl = (name: string) =>
  new Error(
    `${name} must be an HTTP(S) URL without credentials, query, or hash`,
  );

export const resolveOidcUrl = (
  name: string,
  value: string | undefined,
): ResolvedOidcUrl => {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    throw invalidOidcUrl(name);
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw invalidOidcUrl(name);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalidOidcUrl(name);
  }

  return { value: normalized, url };
};

export const resolveRequiredValue = (
  name: string,
  value: string | undefined,
): string => {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    throw new Error(`${name} is required`);
  }
  return normalized;
};

export const resolveLogoutRedirectParameter = (
  value: string | undefined,
): OidcLogoutRedirectParameter => {
  const normalized = value?.trim() || "logout_uri";
  if (
    normalized !== "logout_uri" &&
    normalized !== "post_logout_redirect_uri"
  ) {
    throw new Error(
      "OIDC_LOGOUT_REDIRECT_PARAMETER must be logout_uri or post_logout_redirect_uri",
    );
  }
  return normalized;
};

// Cookie の secure 属性は NODE_ENV ラベルではなく実際に使う URL のスキームから決める。
export const resolveOidcTransportSecurity = ({
  nodeEnvironment,
  appOrigin,
  issuer,
  logoutEndpoint,
}: {
  nodeEnvironment: NodeEnvironment;
  appOrigin: string;
  issuer: URL;
  logoutEndpoint: URL;
}): boolean => {
  const appUrl = new URL(appOrigin);
  const usesHttp =
    appUrl.protocol === "http:" ||
    issuer.protocol === "http:" ||
    logoutEndpoint.protocol === "http:";

  if (nodeEnvironment === "production") {
    if (usesHttp) {
      throw new Error("OIDC requires HTTPS in production");
    }
    return true;
  }

  if (
    usesHttp &&
    (!isLoopbackHost(appUrl.hostname) ||
      !isLoopbackHost(issuer.hostname) ||
      !isLoopbackHost(logoutEndpoint.hostname))
  ) {
    throw new Error("OIDC HTTP URLs require loopback hosts outside production");
  }

  return !usesHttp;
};

export const resolveTransactionTtlSeconds = (
  value: string | undefined,
): number => {
  const seconds = resolveSeconds(
    "OIDC_LOGIN_TRANSACTION_TTL_SECONDS",
    value,
    600,
  );
  if (seconds < 60 || seconds > 600) {
    throw new Error(
      "OIDC_LOGIN_TRANSACTION_TTL_SECONDS must be between 60 and 600 seconds",
    );
  }
  return seconds;
};
