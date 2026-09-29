import { markShutdownSummary } from "./shutdown.js";
import { resolveTelemetryConfig } from "./telemetry-config.js";
import {
  startTelemetry as startNodeTelemetry,
  type TelemetryLifecycle,
} from "./telemetry.js";
import type { ApiProcess } from "./api-main.js";

type ApiModule = {
  startApi(options: { environment: NodeJS.ProcessEnv }): Promise<ApiProcess>;
};

type BootstrapOptions = {
  environment?: NodeJS.ProcessEnv;
  startTelemetry?: (
    config: ReturnType<typeof resolveTelemetryConfig>,
  ) => Promise<TelemetryLifecycle>;
  loadApi?: () => Promise<ApiModule>;
};

const combineClose = (
  api: ApiProcess,
  telemetry: TelemetryLifecycle,
): ApiProcess => {
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        const failures: { stage: string; error: unknown }[] = [];
        try {
          await api.close();
        } catch (error) {
          failures.push({ stage: "API server", error });
        }
        try {
          await telemetry.shutdown();
        } catch (error) {
          failures.push({ stage: "Telemetry", error });
        }
        // どの段が落ちたかは要約メッセージで示し、生のエラーは cause / errors に残す。
        const [only] = failures;
        if (failures.length === 1 && only !== undefined) {
          throw markShutdownSummary(
            new Error(`${only.stage} shutdown failed`, { cause: only.error }),
          );
        }
        if (failures.length > 1) {
          throw markShutdownSummary(
            new AggregateError(
              failures.map((failure) => failure.error),
              "API and telemetry shutdown failed",
            ),
          );
        }
      })();
      return closing;
    },
  };
};

export const bootstrapApi = async ({
  environment = process.env,
  startTelemetry = startNodeTelemetry,
  loadApi = () => import("./api-main.js"),
}: BootstrapOptions = {}): Promise<ApiProcess> => {
  const config = resolveTelemetryConfig(environment);
  const telemetry = await startTelemetry(config);
  try {
    const apiModule = await loadApi();
    const api = await apiModule.startApi({ environment });
    return combineClose(api, telemetry);
  } catch (error) {
    await telemetry.shutdown().catch(() => undefined);
    throw error;
  }
};
