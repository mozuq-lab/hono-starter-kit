import { serve } from "@hono/node-server";
import type { AppType } from "@starter/backend/app-type";
import type { RuntimeComposition } from "./runtime-composition.js";
import { markShutdownSummary } from "./shutdown.js";

type HttpServer = {
  close(callback: (error?: Error) => void): void;
  once(event: "error", listener: (error: Error) => void): HttpServer;
  off(event: "error", listener: (error: Error) => void): HttpServer;
};

type ServeHttp = (
  options: {
    fetch: AppType["fetch"];
    hostname: string;
    port: number;
  },
  listening: () => void,
) => HttpServer;

type ServerDependencies = {
  serveHttp: ServeHttp;
};

const defaultDependencies: ServerDependencies = {
  serveHttp: (options, listening) => serve(options, listening),
};

const closeHttpServer = (server: HttpServer) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

export type RunningServer = {
  close(): Promise<void>;
};

export const startServer = async (
  {
    runtime,
    hostname,
    port,
  }: {
    runtime: RuntimeComposition;
    hostname: string;
    port: number;
  },
  overrides: Partial<ServerDependencies> = {},
): Promise<RunningServer> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  let markListening!: () => void;
  let markListenFailed!: (error: Error) => void;
  const listening = new Promise<void>((resolve, reject) => {
    markListening = resolve;
    markListenFailed = reject;
  });
  const onListenError = (error: Error) => {
    markListenFailed(error);
  };
  const runningServer = await (async () => {
    let server: HttpServer | undefined = undefined;

    try {
      server = dependencies.serveHttp(
        {
          // SERVER span は HttpInstrumentation が作る。ここで包むと SERVER span が 2 つになる。
          fetch: runtime.app.fetch,
          hostname,
          port,
        },
        markListening,
      );
      server.once("error", onListenError);
      await listening;
      server.off("error", onListenError);
      return server;
    } catch (error) {
      server?.off("error", onListenError);
      try {
        await runtime.close();
      } catch {
        // HTTP 起動時のエラーを残し、後片付けの失敗で上書きしない。
        // 後者はドライバ診断を含みうるので外へ出さない。
      }
      throw error;
    }
  })();

  let closing: Promise<void> | undefined;

  return {
    close() {
      closing ??= (async () => {
        let httpError: unknown;
        try {
          await closeHttpServer(runningServer);
        } catch (error) {
          httpError = error;
        }

        // 生のドライバエラーは cause / errors に保持しつつ、ログへ出す要約だけを印付けする。
        try {
          await runtime.close();
        } catch (databaseError) {
          if (httpError !== undefined) {
            throw markShutdownSummary(
              new AggregateError(
                [httpError, databaseError],
                "HTTP and database shutdown failed",
                { cause: databaseError },
              ),
            );
          }
          throw markShutdownSummary(
            new Error("Database shutdown failed", {
              cause: databaseError,
            }),
          );
        }

        if (httpError !== undefined) {
          throw markShutdownSummary(
            new Error("HTTP shutdown failed", { cause: httpError }),
          );
        }
      })();

      return closing;
    },
  };
};
