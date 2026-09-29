import {
  createVerifiedIdentity,
  type ExternalIdentityProvider,
} from "@starter/backend";
import * as oidc from "openid-client";
import type { OidcAuthConfig } from "./auth-config.js";
import { isLoopbackHost } from "./loopback-host.js";

export type OidcIdentityProviderConfig = OidcAuthConfig["oidc"];

export type OidcIdentityProviderDependencies = {
  fetch?: oidc.CustomFetch;
  now?: () => number;
};

type DiscoveryCacheEntry = {
  metadata: Readonly<oidc.ServerMetadata>;
  configuration: oidc.Configuration;
  expiresAtMs: number;
};

type JwksFetchState = {
  body: Uint8Array;
  headers: ReadonlyArray<readonly [string, string]>;
  expiresAtMs: number;
  lastForcedRefreshAtMs?: number;
};

const defaultCacheLifetimeMs = 300_000;
const maximumCacheLifetimeMs = 3_600_000;
const forcedJwksRefreshIntervalMs = 60_000;
const requestDeadlineMs = 5_000;

const allowLoopbackHttp = (issuer: URL): boolean => {
  if (issuer.protocol === "https:") return false;
  if (issuer.protocol === "http:" && isLoopbackHost(issuer.hostname))
    return true;
  throw new Error("OIDC issuer must use HTTPS unless it is loopback");
};

const clampDisplayName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return [...value].slice(0, 200).join("");
};

const cacheLifetimeMs = (cacheControl: string | null): number => {
  if (cacheControl === null) return defaultCacheLifetimeMs;
  for (const directive of cacheControl.split(",")) {
    const match = /^max-age=([0-9]+)$/i.exec(directive.trim());
    if (match === null) continue;
    const seconds = Number(match[1]);
    if (!Number.isSafeInteger(seconds)) return defaultCacheLifetimeMs;
    return Math.min(seconds * 1_000, maximumCacheLifetimeMs);
  }
  return defaultCacheLifetimeMs;
};

const isJsonMediaType = (contentType: string | null): boolean => {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType === "application/jwk-set+json"
  );
};

// 運用ログは summarizeError を通り、素の Error は message が落ちて型名しか残らない。
// 設定の誤りだと型名だけで分かるよう、識別子の形をした専用の名前を付ける。
export class OidcClientAuthenticationUnsupportedError extends Error {
  override name = "OidcClientAuthenticationUnsupportedError";
}

// public client（none）には照合をかけない。Cognito や Google の discovery は、public client を
// 受け付けていても none を載せないため、照合すると同梱の Cognito 構成が起動しなくなる。
// 項目がなければ OpenID Connect Discovery 1.0 の既定（client_secret_basic）として扱う。
const requireSupportedClientAuthentication = (
  method: OidcIdentityProviderConfig["clientAuthentication"]["method"],
  metadata: Readonly<oidc.ServerMetadata>,
) => {
  if (method === "none") return;
  const supported: unknown = metadata.token_endpoint_auth_methods_supported;
  if (supported === undefined) return;
  if (!Array.isArray(supported) || !supported.includes(method)) {
    throw new OidcClientAuthenticationUnsupportedError(
      `OIDC issuer does not list ${method} in token_endpoint_auth_methods_supported`,
    );
  }
};

const createClientAuth = ({
  clientAuthentication,
}: OidcIdentityProviderConfig): oidc.ClientAuth =>
  clientAuthentication.method === "none"
    ? oidc.None()
    : oidc.ClientSecretBasic(clientAuthentication.secret.reveal());

const cachedResponse = (state: JwksFetchState): Response => {
  const headers = new Headers();
  for (const [name, value] of state.headers) headers.append(name, value);
  return new Response(state.body.slice(), { headers, status: 200 });
};

export const createOidcIdentityProvider = (
  config: OidcIdentityProviderConfig,
  dependencies: OidcIdentityProviderDependencies = {},
): ExternalIdentityProvider => {
  const issuer = new URL(config.issuer);
  const insecure = allowLoopbackHttp(issuer);
  const now = dependencies.now ?? Date.now;
  // 生の secret は oauth4webapi の ClientAuth の閉包の中にだけ置く。Configuration の
  // client metadata には入れないので、clientMetadata() からも読めない。
  const clientAuth = createClientAuth(config);
  const baseFetch: oidc.CustomFetch =
    dependencies.fetch ??
    ((url, options) => fetch(url, options as RequestInit));
  let discoveryCache: DiscoveryCacheEntry | undefined;
  let discoveryInFlight: Promise<DiscoveryCacheEntry> | undefined;
  let jwksState: JwksFetchState | undefined;

  const fetchWithDeadline: oidc.CustomFetch = (url, options) => {
    const deadline = AbortSignal.timeout(requestDeadlineMs);
    const signal =
      options.signal === undefined
        ? deadline
        : AbortSignal.any([options.signal, deadline]);
    return baseFetch(url, { ...options, signal });
  };

  const fetchAndMaybeCacheJwks = async (
    url: string,
    options: oidc.CustomFetchOptions,
    lastForcedRefreshAtMs?: number,
  ): Promise<Response> => {
    const response = await fetchWithDeadline(url, options);
    if (response.ok && isJsonMediaType(response.headers.get("content-type"))) {
      try {
        const body = new Uint8Array(await response.clone().arrayBuffer());
        JSON.parse(new TextDecoder().decode(body));
        jwksState = {
          body,
          headers: [...response.headers.entries()],
          expiresAtMs:
            now() + cacheLifetimeMs(response.headers.get("cache-control")),
          ...(lastForcedRefreshAtMs === undefined
            ? {}
            : { lastForcedRefreshAtMs }),
        };
      } catch {
        // ここで JSON として壊れていてもキャッシュしないだけでよい。元の応答は
        // このあと検証側がそのまま消費し、壊れていればそちらが弾く。
      }
    }
    return response;
  };

  const protocolFetch = (jwksUri: string): oidc.CustomFetch => {
    return async (url, options) => {
      if (url !== jwksUri) return fetchWithDeadline(url, options);

      const currentTime = now();
      if (jwksState === undefined || currentTime >= jwksState.expiresAtMs) {
        return fetchAndMaybeCacheJwks(
          url,
          options,
          jwksState?.lastForcedRefreshAtMs,
        );
      }

      const lastForcedRefreshAtMs = jwksState.lastForcedRefreshAtMs;
      if (
        lastForcedRefreshAtMs === undefined ||
        currentTime - lastForcedRefreshAtMs >= forcedJwksRefreshIntervalMs
      ) {
        jwksState.lastForcedRefreshAtMs = currentTime;
        return fetchAndMaybeCacheJwks(url, options, currentTime);
      }

      return cachedResponse(jwksState);
    };
  };

  const prepareConfiguration = (
    configuration: oidc.Configuration,
    metadata: Readonly<oidc.ServerMetadata>,
  ) => {
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== "string") {
      throw new Error("OIDC discovery metadata must include jwks_uri");
    }
    configuration.timeout = 5;
    if (insecure) oidc.allowInsecureRequests(configuration);
    configuration[oidc.customFetch] = protocolFetch(jwksUri);
    oidc.enableNonRepudiationChecks(configuration);
    return configuration;
  };

  const recreateConfiguration = (
    metadata: Readonly<oidc.ServerMetadata>,
  ): oidc.Configuration =>
    prepareConfiguration(
      new oidc.Configuration(
        { ...metadata },
        config.clientId,
        undefined,
        clientAuth,
      ),
      metadata,
    );

  const discover = async (): Promise<DiscoveryCacheEntry> => {
    let expiresAtMs = now() + defaultCacheLifetimeMs;
    const discoveryFetch: oidc.CustomFetch = async (url, options) => {
      const response = await fetchWithDeadline(url, options);
      if (response.ok) {
        expiresAtMs =
          now() + cacheLifetimeMs(response.headers.get("cache-control"));
      }
      return response;
    };
    const configuration = await oidc.discovery(
      issuer,
      config.clientId,
      undefined,
      clientAuth,
      {
        timeout: 5,
        [oidc.customFetch]: discoveryFetch,
        ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
      },
    );
    const metadata = configuration.serverMetadata();
    requireSupportedClientAuthentication(
      config.clientAuthentication.method,
      metadata,
    );
    return {
      metadata,
      configuration: prepareConfiguration(configuration, metadata),
      expiresAtMs,
    };
  };

  const getConfiguration = async () => {
    const currentTime = now();
    if (
      discoveryCache !== undefined &&
      currentTime < discoveryCache.expiresAtMs
    ) {
      if (jwksState !== undefined && currentTime >= jwksState.expiresAtMs) {
        discoveryCache = {
          ...discoveryCache,
          configuration: recreateConfiguration(discoveryCache.metadata),
        };
      }
      return discoveryCache.configuration;
    }

    discoveryInFlight ??= discover();
    try {
      discoveryCache = await discoveryInFlight;
      return discoveryCache.configuration;
    } finally {
      discoveryInFlight = undefined;
    }
  };

  const requireExactRedirectUri = (redirectUri: string, callbackUrl?: URL) => {
    if (redirectUri !== config.redirectUri) {
      throw new Error("OIDC redirect URI does not match configuration");
    }
    if (callbackUrl !== undefined) {
      const callbackRedirectUri = new URL(callbackUrl);
      callbackRedirectUri.search = "";
      callbackRedirectUri.hash = "";
      if (callbackRedirectUri.toString() !== redirectUri) {
        throw new Error("OIDC callback URL does not match redirect URI");
      }
    }
  };

  return {
    async begin({ redirectUri }) {
      requireExactRedirectUri(redirectUri);
      const resolved = await getConfiguration();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(verifier);
      const authorizationUrl = oidc.buildAuthorizationUrl(resolved, {
        client_id: config.clientId,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        nonce,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile email",
        state,
      });
      return {
        authorizationUrl: authorizationUrl.toString(),
        state,
        nonce,
        verifier,
      };
    },

    async complete(input) {
      requireExactRedirectUri(input.redirectUri, input.callbackUrl);
      const resolved = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(
        resolved,
        input.callbackUrl,
        {
          expectedNonce: input.expectedNonce,
          expectedState: input.expectedState,
          idTokenExpected: true,
          pkceCodeVerifier: input.verifier,
        },
      );
      const claims = tokens.claims();
      if (claims === undefined) {
        throw new Error("OIDC ID token is required");
      }
      const displayName = clampDisplayName(claims.name);

      return createVerifiedIdentity({
        provider: "oidc",
        issuer: claims.iss,
        subject: claims.sub,
        email: claims.email_verified === true ? claims.email : undefined,
        displayName,
        roles: [],
      });
    },

    logoutUrl({ postLogoutRedirectUri }) {
      const logoutUrl = new URL(config.logoutEndpoint);
      logoutUrl.searchParams.set("client_id", config.clientId);
      logoutUrl.searchParams.set(
        config.logoutRedirectParameter,
        postLogoutRedirectUri,
      );
      return logoutUrl.toString();
    },
  };
};
