import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "hono/utils/encode";
import {
  decodeExternalLoginCookie,
  encodeExternalLoginCookie,
} from "./external-login-cookie.js";

const validValue = {
  nonce: "n".repeat(32),
  verifier: "v".repeat(128),
};
const textEncoder = new TextEncoder();

const encodedBytes = (value: Uint8Array): string =>
  encodeBase64Url(value.buffer).replace(/=+$/, "");

const encodedJson = (value: unknown): string =>
  encodedBytes(textEncoder.encode(JSON.stringify(value)));

describe("external login cookie codec", () => {
  it("round-trips only the nonce and verifier without base64 padding", () => {
    const encoded = encodeExternalLoginCookie(validValue);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(decodeExternalLoginCookie(encoded)).toEqual(validValue);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["padding", `${encodedJson(validValue)}=`],
    ["non-base64url characters", "not+base64url"],
    ["impossible base64url length", "a"],
    ["malformed UTF-8", encodedBytes(new Uint8Array([0xc3, 0x28]))],
    ["malformed JSON", encodedBytes(textEncoder.encode("{"))],
    ["array", encodedJson([validValue.nonce, validValue.verifier])],
    ["extra key", encodedJson({ ...validValue, state: "secret" })],
    ["missing key", encodedJson({ nonce: validValue.nonce })],
    ["non-string", encodedJson({ ...validValue, verifier: 42 })],
    ["short nonce", encodedJson({ ...validValue, nonce: "n".repeat(31) })],
    [
      "long verifier",
      encodedJson({ ...validValue, verifier: "v".repeat(129) }),
    ],
    [
      "unsafe value characters",
      encodedJson({ ...validValue, nonce: "!".repeat(32) }),
    ],
    [
      "more than 512 decoded bytes",
      encodedBytes(
        textEncoder.encode(`${JSON.stringify(validValue)}${" ".repeat(513)}`),
      ),
    ],
  ])("rejects %s", (_label, encoded) => {
    expect(decodeExternalLoginCookie(encoded)).toBeUndefined();
  });

  it("accepts both value length boundaries and either JSON key order", () => {
    const encoded = encodedJson({
      verifier: "_-".repeat(16),
      nonce: "n".repeat(128),
    });

    expect(decodeExternalLoginCookie(encoded)).toEqual({
      nonce: "n".repeat(128),
      verifier: "_-".repeat(16),
    });
  });
});
