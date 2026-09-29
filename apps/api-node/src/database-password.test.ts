import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDatabasePassword } from "./database-password.js";

const options = { secretArn: "secret-arn-canary", user: "starter_admin" };
const failureMessage =
  "Unable to retrieve PostgreSQL password from Secrets Manager.";

describe("createDatabasePassword", () => {
  it("reuses one Secrets Manager client across connections while still reading AWSCURRENT every time", async () => {
    const passwords = [" first-password ", "second-password"];
    const client = {
      send: vi.fn(() =>
        Promise.resolve({
          SecretString: JSON.stringify({
            username: options.user,
            password: passwords.shift(),
          }),
        }),
      ),
      destroy: vi.fn(),
    };
    const password = createDatabasePassword(options, { client });

    expect(client.send).not.toHaveBeenCalled();
    await expect(password()).resolves.toBe(" first-password ");
    await expect(password()).resolves.toBe("second-password");
    expect(client.send).toHaveBeenCalledTimes(2);
    for (const [command] of client.send.mock.calls as unknown as [
      { input: unknown },
    ][]) {
      expect(command.input).toEqual({
        SecretId: "secret-arn-canary",
        VersionStage: "AWSCURRENT",
      });
    }
    // client の寿命はプロセスの composition が持ち、DB を閉じたあとに destroy する。
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "not-json-password-canary",
    "null",
    "[]",
    "{}",
    JSON.stringify({
      username: "other-user-canary",
      password: "password-canary",
    }),
    JSON.stringify({ username: "starter_admin" }),
    JSON.stringify({ username: "starter_admin", password: 123 }),
    JSON.stringify({ username: "starter_admin", password: "" }),
    JSON.stringify({ username: "starter_admin", password: " \t " }),
  ])(
    "rejects an invalid secret without exposing its contents (%#)",
    async (SecretString) => {
      const password = createDatabasePassword(options, {
        client: {
          send: vi.fn().mockResolvedValue({ SecretString }),
          destroy: vi.fn(),
        },
      });

      await expect(password()).rejects.toThrow(failureMessage);
    },
  );

  it("redacts a send failure including nested SDK diagnostics", async () => {
    const rawError = new Error(
      "password-canary credential-canary secret-arn-canary",
      {
        cause: new Error("provider-token-canary"),
      },
    );
    const password = createDatabasePassword(options, {
      client: {
        send: () => Promise.reject(rawError),
        destroy: vi.fn(),
      },
    });

    let captured: unknown;
    try {
      await password();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe(failureMessage);
    expect((captured as Error).cause).toBeUndefined();
    expect(inspect(captured)).not.toContain("canary");
  });
});
