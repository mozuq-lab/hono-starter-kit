import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { decodeBase64Url, encodeBase64Url } from "hono/utils/encode";
import type { AppEnv } from "../../app/app-env.js";

export type ExternalLoginCookieValue = {
  nonce: string;
  verifier: string;
};

export type ExternalLoginCookieConfig = {
  name: "oidc-transaction" | "__Secure-oidc-transaction";
  secure: boolean;
  path: "/auth/callback";
  maxAgeSeconds: number;
};

// デコード後の JSON に許す上限。nonce と verifier が上限長でも 300 バイト弱に収まるので、
// 余裕を見つつ Cookie 由来の入力に対して JSON.parse へ渡す量を先に断ち切るための値。
const decodedByteLimit = 512;
// decodedByteLimit をパディングなしの base64url にしたときの文字数 = ceil(512 * 4 / 3) = 683。
// encode 側が "=" を落とし base64UrlPattern も "=" を弾くので、基準になるのはパディング付きの
// 長さ（684）ではない。デコードする前に長さだけで弾けるようにしてあり、decodedByteLimit を
// 変えたらこの式で再計算する。
const encodedByteLimit = 683;
// nonce と verifier に許す形。値は oauth4webapi の randomState / randomNonce /
// randomPKCECodeVerifier が生成する 32 バイト乱数の base64url（43 文字）で、
// 上限 128 は RFC 7636 が code_verifier に許す最大長、下限 32 はエントロピーの下限として敷いている。
const protocolValuePattern = /^[A-Za-z0-9_-]{32,128}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const encodeExternalLoginCookie = (
  value: ExternalLoginCookieValue,
): string =>
  encodeBase64Url(textEncoder.encode(JSON.stringify(value)).buffer).replace(
    /=+$/,
    "",
  );

export const decodeExternalLoginCookie = (
  value: string | undefined,
): ExternalLoginCookieValue | undefined => {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > encodedByteLimit ||
    // base64 は 3 バイトを 4 文字にするので、余り 1 文字という長さは成立しない。
    // デコーダによってはこれを黙って受けるため、先に落とす。
    value.length % 4 === 1 ||
    !base64UrlPattern.test(value)
  ) {
    return undefined;
  }

  try {
    const decoded = decodeBase64Url(value);
    if (
      decoded.byteLength > decodedByteLimit ||
      // 再エンコードして一致しなければ、同じバイト列を指す非正規形の表現。パディング付きや
      // 末尾の余りビットが 0 でないものが該当する。取引 Cookie は 1 つの値につき 1 つの表現しか
      // 持たない前提で照合しているので、ここを外すと同一取引を別表現で複数持ち込めるようになる。
      encodeBase64Url(decoded.buffer).replace(/=+$/, "") !== value
    ) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(textDecoder.decode(decoded));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const keys = Object.keys(parsed).sort();
    if (keys.length !== 2 || keys[0] !== "nonce" || keys[1] !== "verifier") {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.nonce !== "string" ||
      typeof candidate.verifier !== "string" ||
      !protocolValuePattern.test(candidate.nonce) ||
      !protocolValuePattern.test(candidate.verifier)
    ) {
      return undefined;
    }
    return { nonce: candidate.nonce, verifier: candidate.verifier };
  } catch {
    return undefined;
  }
};

const cookieAttributes = (config: ExternalLoginCookieConfig) => ({
  httpOnly: true,
  secure: config.secure,
  sameSite: "Lax" as const,
  path: config.path,
  maxAge: config.maxAgeSeconds,
});

export const getExternalLoginCookie = (
  context: Context<AppEnv>,
  config: ExternalLoginCookieConfig,
): ExternalLoginCookieValue | undefined =>
  decodeExternalLoginCookie(getCookie(context, config.name));

export const setExternalLoginCookie = (
  context: Context<AppEnv>,
  config: ExternalLoginCookieConfig,
  value: ExternalLoginCookieValue,
): void => {
  setCookie(
    context,
    config.name,
    encodeExternalLoginCookie(value),
    cookieAttributes(config),
  );
};

export const clearExternalLoginCookie = (
  context: Context<AppEnv>,
  config: ExternalLoginCookieConfig,
): void => {
  deleteCookie(context, config.name, cookieAttributes(config));
};
