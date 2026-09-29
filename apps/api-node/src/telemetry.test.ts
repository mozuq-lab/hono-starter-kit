import { describe, expect, it, vi } from "vitest";
import { startTelemetry } from "./telemetry.js";

describe("startTelemetry", () => {
  it("does not construct an SDK when disabled", async () => {
    const createSdk = vi.fn();
    const telemetry = await startTelemetry({ enabled: false }, { createSdk });
    await telemetry.shutdown();
    expect(createSdk).not.toHaveBeenCalled();
  });

  it("starts once and shuts down once", async () => {
    const sdk = { start: vi.fn(), shutdown: vi.fn(() => Promise.resolve()) };
    const telemetry = await startTelemetry(
      {
        enabled: true,
        serviceName: "api-test",
        tracesUrl: "http://collector:4318/v1/traces",
      },
      { createSdk: vi.fn(() => sdk) },
    );
    expect(sdk.start).toHaveBeenCalledOnce();
    await Promise.all([telemetry.shutdown(), telemetry.shutdown()]);
    expect(sdk.shutdown).toHaveBeenCalledOnce();
  });

  it("shuts down an SDK whose start rejects", async () => {
    const sdk = {
      start: vi.fn(() => Promise.reject(new Error("start failed"))),
      shutdown: vi.fn(() => Promise.resolve()),
    };
    await expect(
      startTelemetry(
        {
          enabled: true,
          serviceName: "api-test",
          tracesUrl: "http://collector:4318/v1/traces",
        },
        { createSdk: () => sdk },
      ),
    ).rejects.toThrow("start failed");
    expect(sdk.shutdown).toHaveBeenCalledOnce();
  });

  // HttpInstrumentation は CommonJS の require("http") に掛かる。ESM だけで動くランタイム
  // （tsx の開発サーバ）では誰も require しないため、SERVER span が 1 つも出なかった。
  it("loads http through CommonJS after the SDK starts so the instrumentation patches the ESM server", async () => {
    const events: string[] = [];
    const sdk = {
      start: vi.fn(() => {
        events.push("start");
      }),
      shutdown: vi.fn(() => Promise.resolve()),
    };

    await startTelemetry(
      {
        enabled: true,
        serviceName: "api-test",
        tracesUrl: "http://collector:4318/v1/traces",
      },
      {
        createSdk: () => sdk,
        loadInstrumentedModules: () => {
          events.push("load instrumented modules");
        },
      },
    );

    expect(events).toEqual(["start", "load instrumented modules"]);
  });

  it("does not load instrumented modules when telemetry is disabled", async () => {
    const loadInstrumentedModules = vi.fn();

    await startTelemetry({ enabled: false }, { loadInstrumentedModules });

    expect(loadInstrumentedModules).not.toHaveBeenCalled();
  });
});
