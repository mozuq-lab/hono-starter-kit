import { createHash, randomBytes, randomUUID } from "node:crypto";

// セッションは「暗号化・署名した Cookie」ではなく opaque token 方式で扱う。
// Cookie には 256bit の乱数そのものを載せ、DB へはその SHA-256 ハッシュだけを保存する。
// したがって鍵も IV も持たず、改ざん検知は「ハッシュに一致するセッションが無い」で成立する。
// この前提で作られているので、値を短くしたりハッシュ保存をやめたりしてはいけない。
export const generateSecureValue = (): string =>
  randomBytes(32).toString("base64url");

export const generateSessionId = generateSecureValue;

export const generateUserId = (): string => `user_${randomUUID()}`;

export const hashValue = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const hashSessionId = hashValue;
