import { parseHost, parsePort } from "./port.js";
import {
  createRuntimeComposition,
  type RuntimeComposition,
  type RuntimeConfiguration,
} from "./runtime-composition.js";
import { RedactedSecret } from "./redacted-secret.js";
import { startServer, type RunningServer } from "./server.js";

export type ApiProcess = { close(): Promise<void> };

type ApiDependencies = {
  createRuntime(environment: RuntimeConfiguration): Promise<RuntimeComposition>;
  startServer(options: {
    runtime: RuntimeComposition;
    hostname: string;
    port: number;
  }): Promise<RunningServer>;
};

const defaultDependencies: ApiDependencies = {
  createRuntime: createRuntimeComposition,
  startServer,
};

export const startApi = async (
  {
    environment = process.env,
  }: {
    environment?: NodeJS.ProcessEnv;
  } = {},
  overrides: Partial<ApiDependencies> = {},
): Promise<ApiProcess> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  const hostname = parseHost(environment.HOST);
  const port = parsePort(environment.PORT);
  const runtime = await dependencies.createRuntime({
    nodeEnv: environment.NODE_ENV,
    databaseEnvironment: {
      ...(environment.DATABASE_URL === undefined
        ? {}
        : { DATABASE_URL: environment.DATABASE_URL }),
      ...(environment.PGHOST === undefined
        ? {}
        : { PGHOST: environment.PGHOST }),
      ...(environment.PGPORT === undefined
        ? {}
        : { PGPORT: environment.PGPORT }),
      ...(environment.PGDATABASE === undefined
        ? {}
        : { PGDATABASE: environment.PGDATABASE }),
      ...(environment.PGUSER === undefined
        ? {}
        : { PGUSER: environment.PGUSER }),
      ...(environment.PGPASSWORD === undefined
        ? {}
        : { PGPASSWORD: environment.PGPASSWORD }),
      ...(environment.PGPASSWORD_SECRET_ARN === undefined
        ? {}
        : { PGPASSWORD_SECRET_ARN: environment.PGPASSWORD_SECRET_ARN }),
      ...(environment.PGSSLROOTCERT === undefined
        ? {}
        : { PGSSLROOTCERT: environment.PGSSLROOTCERT }),
    },
    migrationsDirectory: environment.MIGRATIONS_DIRECTORY,
    scenario: environment.PROJECTS_SCENARIO,
    authProvider: environment.AUTH_PROVIDER,
    appOrigin: environment.APP_ORIGIN,
    sessionAbsoluteTtlSeconds: environment.SESSION_ABSOLUTE_TTL_SECONDS,
    sessionIdleTtlSeconds: environment.SESSION_IDLE_TTL_SECONDS,
    sessionTouchIntervalSeconds: environment.SESSION_TOUCH_INTERVAL_SECONDS,
    oidcIssuer: environment.OIDC_ISSUER,
    oidcClientId: environment.OIDC_CLIENT_ID,
    // 環境変数から読んだその場で包み、実行時設定に生の値の写しを残さない。
    oidcClientSecret:
      environment.OIDC_CLIENT_SECRET === undefined
        ? undefined
        : new RedactedSecret(environment.OIDC_CLIENT_SECRET),
    oidcLogoutEndpoint: environment.OIDC_LOGOUT_ENDPOINT,
    oidcLogoutRedirectParameter: environment.OIDC_LOGOUT_REDIRECT_PARAMETER,
    oidcLoginTransactionTtlSeconds:
      environment.OIDC_LOGIN_TRANSACTION_TTL_SECONDS,
  });
  return dependencies.startServer({ runtime, hostname, port });
};
