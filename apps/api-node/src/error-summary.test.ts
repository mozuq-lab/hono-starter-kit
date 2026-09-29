import { describe, expect, it } from "vitest";
import { summarizeError } from "./error-summary.js";

// pg-protocol の DatabaseError と同じ形。super() の後で name に protocol のメッセージ名
// "error" を入れ、code に SQLSTATE、severity に重大度を持つ。api-node は pg に直接依存しない。
class FakeDatabaseError extends Error {
  code: string;
  severity: string;
  detail: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "error";
    this.code = code;
    this.severity = "ERROR";
    this.detail = "Key (name)=(SECRET_DETAIL) already exists.";
  }
}

const serialized = (error: unknown) => JSON.stringify(summarizeError(error));

describe("summarizeError", () => {
  it("keeps only stack frame lines and drops the name and message header", () => {
    const error = new TypeError("boom");
    error.stack = [
      "TypeError: boom",
      "    at listProjects (file:///app/api.mjs:10:5)",
      "    at async dispatch (file:///app/api.mjs:20:7)",
    ].join("\n");

    expect(summarizeError(error)).toEqual({
      errorName: "TypeError",
      errorMessage: "boom",
      stackFrames: [
        "at listProjects (file:///app/api.mjs:10:5)",
        "at async dispatch (file:///app/api.mjs:20:7)",
      ],
    });
  });

  it("keeps the frames of a real V8 stack", () => {
    const { stackFrames } = summarizeError(new Error("SECRET_MESSAGE"));

    expect(stackFrames.length).toBeGreaterThan(0);
    expect(stackFrames.every((frame) => frame.startsWith("at "))).toBe(true);
    expect(stackFrames.join("\n")).not.toContain("SECRET_MESSAGE");
  });

  // ZodError などは issues の JSON を複数行の message にする。V8 の stack は先頭に
  // `name: message` を丸ごと含むので、stack をそのまま出すと 2 行目以降が漏れる。
  it("does not leak the second and later lines of a multi-line message through the stack", () => {
    const error = new Error('first line\n  "SECRET_SECOND_LINE"\nthird');

    const summary = summarizeError(error);

    expect(summary.stackFrames.length).toBeGreaterThan(0);
    expect(serialized(error)).not.toContain("SECRET_SECOND_LINE");
    expect(serialized(error)).not.toContain("first line");
  });

  it("includes the message only for TypeError, RangeError, and ReferenceError", () => {
    class ProjectionTypeError extends TypeError {}

    expect(summarizeError(new TypeError("t")).errorMessage).toBe("t");
    expect(summarizeError(new RangeError("r")).errorMessage).toBe("r");
    expect(summarizeError(new ReferenceError("f")).errorMessage).toBe("f");
    expect(summarizeError(new ProjectionTypeError("sub")).errorMessage).toBe(
      "sub",
    );

    for (const error of [
      new Error("SECRET_PLAIN"),
      new SyntaxError("SECRET_SYNTAX"),
      new EvalError("SECRET_EVAL"),
      new URIError("SECRET_URI"),
      Object.assign(new Error("SECRET_TOKEN"), { name: "OAuthError" }),
    ]) {
      const summary = summarizeError(error);
      expect(summary).not.toHaveProperty("errorMessage");
      expect(serialized(error)).not.toContain("SECRET_");
    }
    expect(summarizeError(new EvalError("x")).errorName).toBe("EvalError");
  });

  // V8 の JSON.parse は入力の先頭を message に含める（`Unexpected token 'S', "SECRET_VAL"...`）。
  // 本文や IdP の応答、トークンの断片がログに出るので SyntaxError の message は出さない。
  it("omits the message of a JSON.parse SyntaxError, which quotes the input", () => {
    let parseError: unknown;
    try {
      JSON.parse("SECRET_TOKEN_VALUE");
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toBeInstanceOf(SyntaxError);
    expect(String((parseError as Error).message)).toContain("SECRET_TO");
    expect(summarizeError(parseError)).not.toHaveProperty("errorMessage");
    expect(summarizeError(parseError).errorName).toBe("SyntaxError");
    expect(serialized(parseError)).not.toContain("SECRET_TO");
  });

  // 許可した型でも Node の ERR_INVALID_ARG_* は受け取った値を message に含めるので、
  // 長い値がそのまま載らないよう上限で切る。
  it("caps an allowed message at 200 characters", () => {
    const summary = summarizeError(new TypeError("x".repeat(500)));

    expect(summary.errorMessage).toHaveLength(200);
  });

  it("omits the message of a PostgreSQL DatabaseError, including through its stack, and keeps its SQLSTATE", () => {
    const error = new FakeDatabaseError(
      'invalid input syntax for type uuid: "SECRET_INPUT"',
      "22P02",
    );

    const summary = summarizeError(error);

    expect(summary.sqlState).toBe("22P02");
    expect(summary).not.toHaveProperty("errorMessage");
    expect(summary.stackFrames.length).toBeGreaterThan(0);
    expect(serialized(error)).not.toContain("SECRET_INPUT");
    expect(serialized(error)).not.toContain("SECRET_DETAIL");
  });

  it('names a PostgreSQL DatabaseError "DatabaseError" instead of its protocol message name', () => {
    expect(
      summarizeError(new FakeDatabaseError("duplicate key", "23505")).errorName,
    ).toBe("DatabaseError");
  });

  it("does not treat a five-character code without a severity as a SQLSTATE", () => {
    const error = Object.assign(new Error("SECRET"), { code: "ABCDE" });

    expect(summarizeError(error)).not.toHaveProperty("sqlState");
    expect(summarizeError(error).errorName).toBe("Error");
  });

  // pg のエラーは入力値を改行ごと message に含むことがある。stack のフレーム行だけを
  // 選ぶ方式では、空白と "at " で始まる行を message に仕込めば偽のフレームを差し込める。
  it("drops a message line that looks like a stack frame", () => {
    const error = new FakeDatabaseError(
      'bad value "x\n    at FORGED_FRAME (file:///forged.mjs:1:1)"',
      "22P02",
    );

    const summary = summarizeError(error);

    expect(summary.stackFrames.length).toBeGreaterThan(0);
    expect(serialized(error)).not.toContain("FORGED_FRAME");
  });

  // toString を上書きして行数を少なく見せても、ヘッダの行を数え損ねて偽のフレームを通さない。
  it("does not let an overridden toString shorten the stack header", () => {
    class ShortToStringError extends TypeError {
      override toString() {
        return "ShortToStringError";
      }
    }
    const error = new ShortToStringError(
      "first\n    at FORGED_FRAME (file:///forged.mjs:1:1)\nSECRET_TAIL",
    );

    const summary = summarizeError(error);

    expect(summary.stackFrames.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary.stackFrames)).not.toContain("FORGED_FRAME");
    expect(JSON.stringify(summary.stackFrames)).not.toContain("SECRET_TAIL");
  });

  // V8 は stack を最初に読んだ時点の message でヘッダを作る。その後で message を短く
  // 書き換えた Error ではヘッダの行数が分からないので、フレームを捨てる（欠落は漏洩より安全）。
  it("drops every frame when the stack header does not match the current message", () => {
    const error = new TypeError(
      "long\n    at FORGED_FRAME (file:///forged.mjs:1:1)",
    );
    expect(error.stack).toContain("FORGED_FRAME");
    error.message = "short";

    expect(summarizeError(error).stackFrames).toEqual([]);
  });

  it("omits the connection target in an ECONNREFUSED or pool timeout error", () => {
    const refused = Object.assign(
      new Error("connect ECONNREFUSED 10.1.2.3:5432"),
      { code: "ECONNREFUSED", address: "10.1.2.3", port: 5432 },
    );
    const notFound = Object.assign(
      new Error("getaddrinfo ENOTFOUND db.cluster-secret.rds.amazonaws.com"),
      { code: "ENOTFOUND", hostname: "db.cluster-secret.rds.amazonaws.com" },
    );
    const poolTimeout = new Error("timeout exceeded when trying to connect");

    for (const error of [refused, notFound, poolTimeout]) {
      const summary = summarizeError(error);
      expect(summary.errorName).toBe("Error");
      expect(summary).not.toHaveProperty("errorMessage");
      expect(summary).not.toHaveProperty("sqlState");
    }
    expect(serialized(refused)).not.toContain("10.1.2.3");
    expect(serialized(notFound)).not.toContain("rds.amazonaws.com");
    expect(serialized(poolTimeout)).not.toContain("timeout exceeded");
  });

  // oauth4webapi のエラーの cause には IdP の応答が入りうる。AggregateError.errors も
  // 生のドライバエラーを抱える（shutdown と同じ理由）。
  it("never reads error.cause or AggregateError.errors", () => {
    const cause = new TypeError("SECRET_CAUSE");
    const withCause = new TypeError("outer", { cause });
    const aggregate = new AggregateError(
      [new TypeError("SECRET_MEMBER")],
      "SECRET_AGGREGATE",
    );
    Object.defineProperty(withCause, "cause", {
      get: () => {
        throw new Error("cause must not be read");
      },
    });
    Object.defineProperty(aggregate, "errors", {
      get: () => {
        throw new Error("errors must not be read");
      },
    });

    expect(summarizeError(withCause).errorMessage).toBe("outer");
    expect(summarizeError(aggregate)).toMatchObject({
      errorName: "AggregateError",
    });
    expect(serialized(aggregate)).not.toContain("SECRET_");
  });

  it("names a non-Error value by its type without reading it", () => {
    expect(summarizeError({ token: "SECRET_TOKEN" })).toEqual({
      errorName: "object",
      stackFrames: [],
    });
    expect(summarizeError("SECRET_STRING")).toEqual({
      errorName: "string",
      stackFrames: [],
    });
    expect(summarizeError(undefined)).toEqual({
      errorName: "undefined",
      stackFrames: [],
    });
  });

  // name は任意に書き換えられる。ログの 1 行を壊したり値を運んだりできないよう、
  // 識別子の形でない name は型名として扱わない。
  it("does not carry an arbitrary name into the summary", () => {
    const error = Object.assign(new Error("x"), {
      name: "Bad\nname SECRET_NAME",
    });

    expect(summarizeError(error).errorName).toBe("Error");
  });

  it("survives an error whose stack and toString throw", () => {
    const error = new TypeError("message");
    Object.defineProperty(error, "stack", {
      get: () => {
        throw new Error("stack getter failed");
      },
    });
    error.toString = () => {
      throw new Error("toString failed");
    };

    expect(summarizeError(error)).toEqual({
      errorName: "TypeError",
      errorMessage: "message",
      stackFrames: [],
    });
  });
});
