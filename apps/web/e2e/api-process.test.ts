import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_API_PORT,
  createApiSpawnOptions,
  createStop,
  registerGroupExitGuard,
  resolveApiPort,
  signalProcessGroup,
  waitForApiReady,
} from "./api-process.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const readyProbe = {
  childExited: () => false,
  getExitDescription: () => "still running",
  getSpawnError: () => undefined,
  getStderr: () => "",
  url: "http://127.0.0.1:3000/healthz",
};

describe("waitForApiReady", () => {
  it("waits through an unhealthy health response until HTTP 200", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await waitForApiReady(readyProbe);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("probes the health endpoint of the resolved port", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await waitForApiReady({
      ...readyProbe,
      url: "http://127.0.0.1:4321/healthz",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/healthz",
      expect.anything(),
    );
  });
});

describe("resolveApiPort", () => {
  it("falls back to the default port when no override is configured", () => {
    expect(resolveApiPort({})).toBe(DEFAULT_API_PORT);
  });

  it("uses the configured E2E_API_PORT override", () => {
    expect(resolveApiPort({ E2E_API_PORT: "4321" })).toBe(4321);
  });

  it("rejects an E2E_API_PORT override that is not a usable port", () => {
    expect(() => resolveApiPort({ E2E_API_PORT: "not-a-port" })).toThrow(
      /E2E_API_PORT/u,
    );
    expect(() => resolveApiPort({ E2E_API_PORT: "70000" })).toThrow(
      /E2E_API_PORT/u,
    );
  });
});

describe("createApiSpawnOptions", () => {
  it("detaches the API into its own process group", () => {
    expect(
      createApiSpawnOptions({ environment: {}, port: 4321, scenario: "empty" }),
    ).toMatchObject({ detached: true });
  });

  it("passes the resolved port and scenario to the API process", () => {
    const options = createApiSpawnOptions({
      environment: { PATH: "/usr/bin" },
      port: 4321,
      scenario: "error",
    });

    expect(options.env).toMatchObject({
      PATH: "/usr/bin",
      PORT: "4321",
      PROJECTS_SCENARIO: "error",
    });
  });
});

describe("signalProcessGroup", () => {
  it("signals the whole process group rather than the direct child", () => {
    const sendSignal = vi.fn();

    expect(signalProcessGroup(4321, "SIGTERM", sendSignal)).toBe(true);
    expect(sendSignal).toHaveBeenCalledWith(-4321, "SIGTERM");
  });

  it("reports a group that has already exited instead of throwing", () => {
    const sendSignal = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    expect(signalProcessGroup(4321, "SIGTERM", sendSignal)).toBe(false);
  });

  it("propagates unexpected signalling failures", () => {
    const sendSignal = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(() => signalProcessGroup(4321, "SIGTERM", sendSignal)).toThrow(
      "not permitted",
    );
  });
});

describe("registerGroupExitGuard", () => {
  const createExitTarget = () => {
    const listeners = new Set<() => void>();
    return {
      emitExit: () => {
        for (const listener of listeners) listener();
      },
      listenerCount: () => listeners.size,
      off: (_event: "exit", listener: () => void) => listeners.delete(listener),
      once: (_event: "exit", listener: () => void) => listeners.add(listener),
    };
  };

  it("kills the orphaned process group when the harness process exits", () => {
    const sendSignal = vi.fn();
    const target = createExitTarget();

    registerGroupExitGuard(4321, sendSignal, target);
    target.emitExit();

    expect(sendSignal).toHaveBeenCalledWith(-4321, "SIGKILL");
  });

  it("stops guarding once the API has been stopped normally", () => {
    const sendSignal = vi.fn();
    const target = createExitTarget();

    registerGroupExitGuard(4321, sendSignal, target)();
    target.emitExit();

    expect(target.listenerCount()).toBe(0);
    expect(sendSignal).not.toHaveBeenCalled();
  });
});

describe("createStop", () => {
  const createExitControl = () => {
    let exit = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    return { exit: () => exit(), exited };
  };

  it("terminates the whole process group and waits for the port to be released", async () => {
    const { exit, exited } = createExitControl();
    let running = true;
    const sendSignal = vi.fn(() => {
      running = false;
      exit();
    });
    const waitForPortRelease = vi.fn(() => Promise.resolve());

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      exited,
      () => !running,
      { sendSignal, stopTimeoutMs: 50, waitForPortRelease },
    );
    await stop();

    expect(sendSignal).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(waitForPortRelease).toHaveBeenCalledTimes(1);
  });

  it("escalates to SIGKILL for the whole group when SIGTERM is ignored", async () => {
    const { exit, exited } = createExitControl();
    let running = true;
    const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        running = false;
        exit();
      }
    });

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      exited,
      () => !running,
      {
        sendSignal,
        stopTimeoutMs: 10,
        waitForPortRelease: () => Promise.resolve(),
      },
    );
    await stop();

    expect(sendSignal.mock.calls).toEqual([
      [-4321, "SIGTERM"],
      [-4321, "SIGKILL"],
    ]);
  });

  it("falls back to the direct child when the process group is gone", async () => {
    const { exit, exited } = createExitControl();
    let running = true;
    const kill = vi.fn(() => {
      running = false;
      exit();
      return true;
    });
    const sendSignal = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    const stop = createStop({ kill, pid: 4321 }, exited, () => !running, {
      sendSignal,
      stopTimeoutMs: 50,
      waitForPortRelease: () => Promise.resolve(),
    });
    await stop();

    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops only once even when called concurrently", async () => {
    const { exit, exited } = createExitControl();
    let running = true;
    const sendSignal = vi.fn(() => {
      running = false;
      exit();
    });
    const waitForPortRelease = vi.fn(() => Promise.resolve());

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      exited,
      () => !running,
      { sendSignal, stopTimeoutMs: 50, waitForPortRelease },
    );
    await Promise.all([stop(), stop()]);

    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(waitForPortRelease).toHaveBeenCalledTimes(1);
  });

  it("still confirms the port release when the API already exited", async () => {
    const sendSignal = vi.fn();
    const waitForPortRelease = vi.fn(() => Promise.resolve());

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      Promise.resolve(),
      () => true,
      { sendSignal, stopTimeoutMs: 50, waitForPortRelease },
    );
    await stop();

    expect(sendSignal).not.toHaveBeenCalled();
    expect(waitForPortRelease).toHaveBeenCalledTimes(1);
  });
});
