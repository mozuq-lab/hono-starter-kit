import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_API_PORT,
  type HealthProbe,
  createApiSpawnOptions,
  createStop,
  isProcessGroupAlive,
  registerGroupExitGuard,
  resolveApiPort,
  signalProcessGroup,
  waitForApiReady,
} from "./api-process.js";

const readyProbe = {
  childExited: () => false,
  getExitDescription: () => "still running",
  getSpawnError: () => undefined,
  getStderr: () => "",
  url: "http://127.0.0.1:3000/healthz",
};

describe("waitForApiReady", () => {
  it("waits through an unhealthy health response until HTTP 200", async () => {
    const probe = vi
      .fn<HealthProbe>()
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(200);

    await waitForApiReady({ ...readyProbe, probe });

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes the health endpoint of the resolved port", async () => {
    const probe = vi.fn<HealthProbe>().mockResolvedValue(200);

    await waitForApiReady({
      ...readyProbe,
      url: "http://127.0.0.1:4321/healthz",
      probe,
    });

    expect(probe).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/healthz",
      expect.any(Number),
    );
  });

  it("ignores a kept-alive connection to an API that has stopped listening", async () => {
    // 停止中の API は listener を閉じたあとも、終了するまで既存の接続には応答する。
    // 前のテストで張った接続を使い回すと、まだ起動していない次の API を ready と誤認する。
    const sockets = new Set<Socket>();
    const stoppedApi = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nKeep-Alive: timeout=30\r\n\r\n",
        );
      });
    });
    await new Promise<void>((resolve) => {
      stoppedApi.listen(0, "127.0.0.1", resolve);
    });
    const { port } = stoppedApi.address() as AddressInfo;
    const url = `http://127.0.0.1:${String(port)}/healthz`;

    try {
      await (await fetch(url)).arrayBuffer();
      stoppedApi.close();

      await expect(
        waitForApiReady({ ...readyProbe, url, timeoutMs: 300 }),
      ).rejects.toThrow(/did not become ready within 300 ms/u);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
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

describe("isProcessGroupAlive", () => {
  it("probes the whole group with signal 0", () => {
    const probe = vi.fn();

    expect(isProcessGroupAlive(4321, probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith(-4321, 0);
  });

  it("reports a group that no longer exists", () => {
    const probe = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    expect(isProcessGroupAlive(4321, probe)).toBe(false);
  });

  it("treats a group it may not signal as still alive", () => {
    const probe = vi.fn(() => {
      throw Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
      });
    });

    expect(isProcessGroupAlive(4321, probe)).toBe(true);
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
      {
        isGroupAlive: () => false,
        sendSignal,
        stopTimeoutMs: 50,
        waitForPortRelease,
      },
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
        isGroupAlive: () => false,
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
      isGroupAlive: () => false,
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
      {
        isGroupAlive: () => false,
        sendSignal,
        stopTimeoutMs: 50,
        waitForPortRelease,
      },
    );
    await Promise.all([stop(), stop()]);

    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(waitForPortRelease).toHaveBeenCalledTimes(1);
  });

  it("waits for the rest of the process group after the direct child exits", async () => {
    // 直接の子（pnpm）が先に終わっても、孫の tsx と API は終了処理の途中で生きていることがある。
    let groupPolls = 0;
    const events: string[] = [];
    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      Promise.resolve(),
      () => true,
      {
        isGroupAlive: () => {
          groupPolls += 1;
          return groupPolls < 3;
        },
        sendSignal: vi.fn(),
        stopTimeoutMs: 1_000,
        waitForPortRelease: () => {
          events.push(`port checked after ${String(groupPolls)} polls`);
          return Promise.resolve();
        },
      },
    );
    await stop();

    expect(events).toEqual(["port checked after 3 polls"]);
  });

  it("kills the remaining process group when it outlives the stop timeout", async () => {
    let groupAlive = true;
    const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") groupAlive = false;
    });

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      Promise.resolve(),
      () => true,
      {
        isGroupAlive: () => groupAlive,
        sendSignal,
        stopTimeoutMs: 20,
        waitForPortRelease: () => Promise.resolve(),
      },
    );
    await stop();

    expect(sendSignal.mock.calls).toEqual([[-4321, "SIGKILL"]]);
  });

  it("kills the remaining group after a short grace instead of the full stop timeout", async () => {
    let groupAlive = true;
    const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") groupAlive = false;
    });
    const startedAt = Date.now();

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      Promise.resolve(),
      () => true,
      {
        groupExitGraceMs: 20,
        isGroupAlive: () => groupAlive,
        sendSignal,
        stopTimeoutMs: 10_000,
        waitForPortRelease: () => Promise.resolve(),
      },
    );
    await stop();

    expect(sendSignal.mock.calls).toEqual([[-4321, "SIGKILL"]]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("still confirms the port release when the API already exited", async () => {
    const sendSignal = vi.fn();
    const waitForPortRelease = vi.fn(() => Promise.resolve());

    const stop = createStop(
      { kill: vi.fn(), pid: 4321 },
      Promise.resolve(),
      () => true,
      {
        isGroupAlive: () => false,
        sendSignal,
        stopTimeoutMs: 50,
        waitForPortRelease,
      },
    );
    await stop();

    expect(sendSignal).not.toHaveBeenCalled();
    expect(waitForPortRelease).toHaveBeenCalledTimes(1);
  });
});
