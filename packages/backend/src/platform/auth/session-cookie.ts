import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../../app/app-env.js";

export type SessionCookieConfig = {
  name: "session" | "__Host-session";
  secure: boolean;
  maxAgeSeconds: number;
};

const cookieAttributes = (config: SessionCookieConfig) => ({
  httpOnly: true,
  secure: config.secure,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: config.maxAgeSeconds,
});

export const getSessionCookie = (
  context: Context<AppEnv>,
  config: SessionCookieConfig,
): string | undefined => getCookie(context, config.name);

export const setSessionCookie = (
  context: Context<AppEnv>,
  config: SessionCookieConfig,
  value: string,
): void => {
  setCookie(context, config.name, value, cookieAttributes(config));
};

export const clearSessionCookie = (
  context: Context<AppEnv>,
  config: SessionCookieConfig,
): void => {
  deleteCookie(context, config.name, cookieAttributes(config));
};
