import { createHash, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  request as requestHttps,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
// scripts/docker/production-image.ts がこのファイルを type stripping でそのまま読み込む。
// 相対パスの実行時 import は `.js` の指定子がディスク上に無く解決できないので、型だけを import する。
import type { OidcClientAuthentication } from "../auth-config.js";
import type { RedactedSecret } from "../redacted-secret.js";

type FixtureClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [claim: string]: unknown;
};

type IdTokenOptions = {
  audience?: string | string[];
  expiresInSeconds?: number;
  issuer?: string;
  nonce?: string;
  omit?: boolean;
  signature?: "active" | "untrusted";
};

export type OidcFixtureOptions = {
  accessToken?: string;
  bindAddress?: string;
  cacheControl?: {
    discovery?: string;
    jwks?: string;
  };
  claims: FixtureClaims;
  /** 与えると confidential client として振る舞い、token endpoint で Basic 認証を必須にする。 */
  clientSecret?: RedactedSecret;
  delays?: {
    discoveryMs?: number;
    jwksMs?: number;
    tokenMs?: number;
  };
  discoveryBody?: unknown;
  idToken?: IdTokenOptions;
  issuerHostname?: string;
  issuerOrigin?: string;
  jwksStatuses?: number[];
  redirectUri?: string;
  tls?: HttpsServerOptions;
  /**
   * discovery の token_endpoint_auth_methods_supported。"omit" で項目ごと載せない。
   * 既定は clientSecret があれば ["client_secret_basic"]、なければ ["none"]。
   */
  tokenEndpointAuthMethodsSupported?: readonly string[] | "omit";
};

export type FixtureTokenRequest = {
  clientAuthentication: "client_secret_basic" | "none";
  codeVerifier: boolean;
};

type SigningKey = {
  jwk: JWK;
  kid: string;
  privateKey: CryptoKey;
};

type AuthorizationRecord = {
  challenge: string;
  nonce: string;
  redirectUri: string;
};

export type OidcFixture = {
  authorize(authorizationUrl: URL): Promise<URL>;
  bindAddress: string;
  clientConfig: {
    clientAuthentication: OidcClientAuthentication;
    clientId: string;
    issuer: string;
    logoutEndpoint: string;
    logoutRedirectParameter: "logout_uri";
    postLogoutRedirectUri: string;
    redirectUri: string;
  };
  close(): Promise<void>;
  issuer: string;
  redirectUri: string;
  requestCounts: {
    authorize: number;
    discovery: number;
    jwks: number;
    token: number;
    unexpected: number;
  };
  rotateSigningKey(): Promise<void>;
  /** クライアント認証を通った token リクエストだけを、届いた順に記録する。 */
  tokenRequests: FixtureTokenRequest[];
};

const openFixtures = new Set<OidcFixture>();

const createSigningKey = async (): Promise<SigningKey> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = randomUUID();
  return {
    privateKey,
    kid,
    jwk: {
      ...(await exportJWK(publicKey)),
      alg: "RS256",
      kid,
      use: "sig",
    },
  };
};

// oauth4webapi の Basic 認証は id と secret を form-urlencode してから base64 にする
// （RFC 6749 §2.3.1）。IdP と同じ順で戻す: base64 → 最初の `:` で分割 → `+` を空白 →
// percent-decode。secret 側の `:` は %3A に符号化されているので、最初の `:` で切ってよい。
// 符号化を省いた Basic（生の `+` を含むもの）は、ここで別の値に戻って照合に失敗する。
const decodeBasicCredentials = (
  header: string | undefined,
): { id: string; secret: string } | undefined => {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header ?? "");
  if (match === null) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  const formUrlDecode = (value: string) =>
    decodeURIComponent(value.replaceAll("+", " "));
  try {
    return {
      id: formUrlDecode(decoded.slice(0, separator)),
      secret: formUrlDecode(decoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
};

// oauth4webapi の formUrlEncode と同じ規則。encodeURIComponent が残す `-_.!~*'()` も
// %XX にし、空白は `+` にする。
const formUrlEncode = (value: string): string =>
  encodeURIComponent(value)
    .replace(
      /[-_.!~*'()]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replaceAll("%20", "+");

/**
 * ログや例外に secret が混ざっていないかを調べるときの、secret の表れ方の一覧。
 * 生の値に加え、token リクエストで実際に送られる form-urlencode 形と、Basic ヘッダーの
 * base64 形を含める。生の値だけを調べると、送信時の形で漏れても見逃す。
 */
export const clientSecretWireForms = ({
  clientId,
  secret,
}: {
  clientId: string;
  secret: string;
}): string[] => [
  secret,
  encodeURIComponent(secret),
  formUrlEncode(secret),
  Buffer.from(secret).toString("base64"),
  Buffer.from(`${formUrlEncode(clientId)}:${formUrlEncode(secret)}`).toString(
    "base64",
  ),
];

const delay = async (milliseconds: number | undefined) => {
  if (milliseconds === undefined || milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    if (typeof chunk === "string" || chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      throw new Error("OIDC fixture received an invalid request body");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  cacheControl?: string,
  contentType = "application/json",
) => {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  if (cacheControl !== undefined) {
    response.setHeader("Cache-Control", cacheControl);
  }
  response.end(JSON.stringify(body));
};

const listen = async (server: Server, bindAddress: string) => {
  server.listen(0, bindAddress);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OIDC fixture did not bind a TCP port");
  }
  return { address: address.address, port: address.port };
};

const resolveIssuerOrigin = ({
  defaultProtocol,
  issuerHostname,
  issuerOrigin,
  port,
}: {
  defaultProtocol: "http:" | "https:";
  issuerHostname: string | undefined;
  issuerOrigin: string | undefined;
  port: number;
}): string => {
  if (issuerHostname !== undefined && issuerOrigin !== undefined) {
    throw new Error(
      "OIDC fixture accepts issuerHostname or issuerOrigin, not both",
    );
  }
  if (issuerOrigin !== undefined) {
    const url = new URL(issuerOrigin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("OIDC fixture issuerOrigin must be an HTTP(S) origin");
    }
    return url.origin;
  }
  if (issuerHostname !== undefined) {
    const url = new URL(`http://${issuerHostname}`);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("OIDC fixture issuerHostname must be a hostname");
    }
    url.protocol = defaultProtocol;
    url.port = String(port);
    return url.origin;
  }
  return `${defaultProtocol}//127.0.0.1:${port}`;
};

const resolveRedirectUri = (value: string | undefined): string => {
  const redirectUri = value ?? "http://127.0.0.1:5173/auth/callback";
  const url = new URL(redirectUri);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("OIDC fixture redirectUri must be an HTTP(S) URL");
  }
  return url.toString();
};

const localConnectHostname = (boundAddress: string): string => {
  if (boundAddress === "0.0.0.0") return "127.0.0.1";
  if (boundAddress === "::") return "[::1]";
  return boundAddress.includes(":") ? `[${boundAddress}]` : boundAddress;
};

const authorizeThroughLocalTls = async ({
  authorizationUrl,
  localOrigin,
  tls,
}: {
  authorizationUrl: URL;
  localOrigin: string;
  tls: HttpsServerOptions;
}): Promise<{ location: string | undefined; status: number | undefined }> => {
  const local = new URL(localOrigin);
  return new Promise((resolve, reject) => {
    const request = requestHttps(
      {
        ca: tls.ca,
        hostname: local.hostname,
        method: "GET",
        path: `${authorizationUrl.pathname}${authorizationUrl.search}`,
        port: local.port,
        servername: authorizationUrl.hostname,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const location = response.headers.location;
          resolve({
            location,
            status: response.statusCode,
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
};

export const startOidcFixture = async (
  options: OidcFixtureOptions,
): Promise<OidcFixture> => {
  const clientSecret = options.clientSecret;
  const clientId =
    clientSecret === undefined
      ? "fixture-public-client"
      : "fixture-confidential-client";
  const tokenEndpointAuthMethodsSupported =
    options.tokenEndpointAuthMethodsSupported ??
    (clientSecret === undefined ? ["none"] : ["client_secret_basic"]);
  const tokenRequests: FixtureTokenRequest[] = [];
  const accessToken = options.accessToken ?? "discarded-access-token";
  const requestedBindAddress = options.bindAddress ?? "127.0.0.1";
  const redirectUri = resolveRedirectUri(options.redirectUri);
  const protocol = options.tls === undefined ? "http:" : "https:";
  resolveIssuerOrigin({
    defaultProtocol: protocol,
    issuerHostname: options.issuerHostname,
    issuerOrigin: options.issuerOrigin,
    port: 1,
  });
  let activeKey = await createSigningKey();
  const untrustedKey = await createSigningKey();
  const authorizations = new Map<string, AuthorizationRecord>();
  let authorizationSequence = 0;
  let issuer = "";

  const requestCounts = {
    authorize: 0,
    discovery: 0,
    jwks: 0,
    token: 0,
    unexpected: 0,
  };

  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    try {
      const url = new URL(request.url ?? "/", issuer);

      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/openid-configuration"
      ) {
        requestCounts.discovery += 1;
        await delay(options.delays?.discoveryMs);
        const body = options.discoveryBody ?? {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          ...(tokenEndpointAuthMethodsSupported === "omit"
            ? {}
            : {
                token_endpoint_auth_methods_supported:
                  tokenEndpointAuthMethodsSupported,
              }),
        };
        sendJson(response, 200, body, options.cacheControl?.discovery);
        return;
      }

      if (request.method === "GET" && url.pathname === "/authorize") {
        requestCounts.authorize += 1;
        const exactScope =
          url.searchParams.get("scope") === "openid profile email";
        const valid =
          url.searchParams.get("response_type") === "code" &&
          url.searchParams.get("client_id") === clientId &&
          url.searchParams.get("redirect_uri") === redirectUri &&
          url.searchParams.get("code_challenge_method") === "S256" &&
          exactScope;
        const state = url.searchParams.get("state");
        const nonce = url.searchParams.get("nonce");
        const challenge = url.searchParams.get("code_challenge");
        if (!valid || state === null || nonce === null || challenge === null) {
          sendJson(response, 400, { error: "invalid_request" });
          return;
        }

        const code = `fixture-code-${++authorizationSequence}`;
        authorizations.set(code, { challenge, nonce, redirectUri });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        response.statusCode = 302;
        response.setHeader("Location", callback.toString());
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/token") {
        requestCounts.token += 1;
        await delay(options.delays?.tokenMs);
        const parameters = new URLSearchParams(await readBody(request));
        const bodyClientId = parameters.get("client_id");
        if (clientSecret === undefined) {
          if (
            request.headers.authorization !== undefined ||
            bodyClientId !== clientId
          ) {
            sendJson(response, 400, { error: "invalid_client" });
            return;
          }
        } else {
          const credentials = decodeBasicCredentials(
            request.headers.authorization,
          );
          if (
            credentials?.id !== clientId ||
            credentials.secret !== clientSecret.reveal() ||
            (bodyClientId !== null && bodyClientId !== clientId) ||
            parameters.has("client_secret")
          ) {
            sendJson(response, 401, { error: "invalid_client" });
            return;
          }
        }
        tokenRequests.push({
          clientAuthentication:
            clientSecret === undefined ? "none" : "client_secret_basic",
          codeVerifier: parameters.has("code_verifier"),
        });
        const code = parameters.get("code");
        const authorization =
          code === null ? undefined : authorizations.get(code);
        if (code !== null) authorizations.delete(code);
        const verifier = parameters.get("code_verifier");
        const challenge =
          verifier === null
            ? undefined
            : createHash("sha256")
                .update(verifier, "ascii")
                .digest("base64url");
        if (
          authorization === undefined ||
          challenge !== authorization.challenge ||
          parameters.get("grant_type") !== "authorization_code" ||
          parameters.get("redirect_uri") !== authorization.redirectUri
        ) {
          sendJson(response, 400, { error: "invalid_grant" });
          return;
        }

        if (options.idToken?.omit === true) {
          sendJson(response, 200, {
            access_token: accessToken,
            token_type: "Bearer",
          });
          return;
        }

        const nowSeconds = Math.floor(Date.now() / 1000);
        const { sub, ...claims } = options.claims;
        const signingKey =
          options.idToken?.signature === "untrusted" ? untrustedKey : activeKey;
        const idToken = await new SignJWT({
          ...claims,
          nonce: options.idToken?.nonce ?? authorization.nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: activeKey.kid })
          .setIssuer(options.idToken?.issuer ?? issuer)
          .setAudience(options.idToken?.audience ?? clientId)
          .setSubject(sub)
          .setIssuedAt(nowSeconds)
          .setExpirationTime(
            nowSeconds + (options.idToken?.expiresInSeconds ?? 300),
          )
          .sign(signingKey.privateKey);
        sendJson(response, 200, {
          access_token: accessToken,
          id_token: idToken,
          token_type: "Bearer",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/jwks") {
        requestCounts.jwks += 1;
        await delay(options.delays?.jwksMs);
        const status = options.jwksStatuses?.shift() ?? 200;
        if (status !== 200) {
          sendJson(response, status, { error: "temporarily_unavailable" });
          return;
        }
        sendJson(
          response,
          200,
          { keys: [activeKey.jwk] },
          options.cacheControl?.jwks,
          "application/jwk-set+json; charset=utf-8",
        );
        return;
      }

      requestCounts.unexpected += 1;
      sendJson(response, 404, { error: "not_found" });
    } catch {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "fixture_error" });
      } else {
        response.destroy();
      }
    }
  };

  const server =
    options.tls === undefined
      ? createHttpServer((request, response) => {
          void handler(request, response);
        })
      : createHttpsServer(options.tls, (request, response) => {
          void handler(request, response);
        });
  const listening = await listen(server, requestedBindAddress);
  issuer = resolveIssuerOrigin({
    defaultProtocol: protocol,
    issuerHostname: options.issuerHostname,
    issuerOrigin: options.issuerOrigin,
    port: listening.port,
  });
  const localOrigin = `${protocol}//${localConnectHostname(listening.address)}:${listening.port}`;

  let closed = false;
  const fixture: OidcFixture = {
    bindAddress: listening.address,
    issuer,
    redirectUri,
    clientConfig: {
      issuer,
      clientId,
      clientAuthentication:
        clientSecret === undefined
          ? { method: "none" }
          : { method: "client_secret_basic", secret: clientSecret },
      logoutEndpoint: `${issuer}/logout`,
      logoutRedirectParameter: "logout_uri",
      redirectUri,
      postLogoutRedirectUri: new URL("/login", redirectUri).toString(),
    },
    requestCounts,
    tokenRequests,
    async authorize(authorizationUrl) {
      if (authorizationUrl.origin !== issuer) {
        throw new Error("OIDC fixture authorization URL has the wrong origin");
      }
      const localAuthorizationUrl = new URL(authorizationUrl);
      const local = new URL(localOrigin);
      localAuthorizationUrl.protocol = local.protocol;
      localAuthorizationUrl.hostname = local.hostname;
      localAuthorizationUrl.port = local.port;
      const result =
        options.tls === undefined
          ? await (async () => {
              const response = await fetch(localAuthorizationUrl, {
                redirect: "manual",
              });
              return {
                location: response.headers.get("location") ?? undefined,
                status: response.status,
              };
            })()
          : await authorizeThroughLocalTls({
              authorizationUrl,
              localOrigin,
              tls: options.tls,
            });
      if (result.status !== 302 || result.location === undefined) {
        throw new Error("OIDC fixture authorization failed");
      }
      return new URL(result.location);
    },
    async rotateSigningKey() {
      activeKey = await createSigningKey();
    },
    async close() {
      if (closed) return;
      closed = true;
      openFixtures.delete(fixture);
      server.close();
      await once(server, "close");
    },
  };
  openFixtures.add(fixture);
  return fixture;
};

export const closeAllOidcFixtures = async (): Promise<void> => {
  await Promise.all([...openFixtures].map((fixture) => fixture.close()));
};

export const getOpenOidcFixtureCount = (): number => openFixtures.size;
