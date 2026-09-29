import { describe, expect, it, vi } from "vitest";
import { annotateActiveSpanWithRequestId } from "./request-id.js";

describe("annotateActiveSpanWithRequestId", () => {
  it("sets only the request.id attribute", () => {
    const setAttribute = vi.fn();

    annotateActiveSpanWithRequestId("request-123", {
      setAttribute,
    });

    expect(setAttribute).toHaveBeenCalledOnce();
    expect(setAttribute).toHaveBeenCalledWith("request.id", "request-123");
  });

  it("is harmless without an active span", () => {
    expect(() =>
      annotateActiveSpanWithRequestId("request-123", undefined),
    ).not.toThrow();
  });
});
