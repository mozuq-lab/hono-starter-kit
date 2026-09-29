import type { SessionCookieConfig, SessionPolicy } from "@starter/backend";

const defaultAbsoluteTtlSeconds = 604_800;
const defaultIdleTtlSeconds = 86_400;
const defaultTouchIntervalSeconds = 300;
const maximumAbsoluteTtlSeconds = 34_560_000;

export type SessionEnvironment = {
  SESSION_ABSOLUTE_TTL_SECONDS?: string | undefined;
  SESSION_IDLE_TTL_SECONDS?: string | undefined;
  SESSION_TOUCH_INTERVAL_SECONDS?: string | undefined;
};

export type OidcTransactionCookieConfig = {
  name: "oidc-transaction" | "__Secure-oidc-transaction";
  secure: boolean;
  path: "/auth/callback";
  maxAgeSeconds: number;
};

export type ResolvedSessionPolicy = {
  absoluteTtlSeconds: number;
  policy: SessionPolicy;
};

export const resolveSeconds = (
  name: string,
  value: string | undefined,
  defaultValue: number,
): number => {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return defaultValue;

  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(
      `${name} must be a positive safe integer number of seconds`,
    );
  }

  const seconds = Number(normalized);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000)) {
    throw new Error(
      `${name} must be a positive safe integer number of seconds`,
    );
  }

  return seconds;
};

export const resolveSessionPolicy = (
  environment: SessionEnvironment,
): ResolvedSessionPolicy => {
  const absoluteTtlSeconds = resolveSeconds(
    "SESSION_ABSOLUTE_TTL_SECONDS",
    environment.SESSION_ABSOLUTE_TTL_SECONDS,
    defaultAbsoluteTtlSeconds,
  );
  if (absoluteTtlSeconds > maximumAbsoluteTtlSeconds) {
    throw new Error(
      "SESSION_ABSOLUTE_TTL_SECONDS must not exceed 34560000 seconds (400 days), the cookie Max-Age limit",
    );
  }
  const idleTtlSeconds = resolveSeconds(
    "SESSION_IDLE_TTL_SECONDS",
    environment.SESSION_IDLE_TTL_SECONDS,
    defaultIdleTtlSeconds,
  );
  const touchIntervalSeconds = resolveSeconds(
    "SESSION_TOUCH_INTERVAL_SECONDS",
    environment.SESSION_TOUCH_INTERVAL_SECONDS,
    defaultTouchIntervalSeconds,
  );

  if (idleTtlSeconds > absoluteTtlSeconds) {
    throw new Error(
      "SESSION_IDLE_TTL_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS",
    );
  }
  if (touchIntervalSeconds >= idleTtlSeconds) {
    throw new Error(
      "SESSION_TOUCH_INTERVAL_SECONDS must be less than SESSION_IDLE_TTL_SECONDS",
    );
  }

  return {
    absoluteTtlSeconds,
    policy: {
      absoluteTtlMs: absoluteTtlSeconds * 1000,
      idleTtlMs: idleTtlSeconds * 1000,
      touchIntervalMs: touchIntervalSeconds * 1000,
    },
  };
};

// __Host- / __Secure- 接頭辞は secure 属性とセットでしか成立しないため、命名は secure から導く。
export const resolveSessionCookie = ({
  secure,
  maxAgeSeconds,
}: {
  secure: boolean;
  maxAgeSeconds: number;
}): SessionCookieConfig => ({
  name: secure ? "__Host-session" : "session",
  secure,
  maxAgeSeconds,
});

export const resolveTransactionCookie = ({
  secure,
  maxAgeSeconds,
}: {
  secure: boolean;
  maxAgeSeconds: number;
}): OidcTransactionCookieConfig => ({
  name: secure ? "__Secure-oidc-transaction" : "oidc-transaction",
  secure,
  path: "/auth/callback",
  maxAgeSeconds,
});
