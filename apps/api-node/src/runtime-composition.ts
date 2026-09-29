import {
  InMemoryAuthSessionStore,
  InMemoryExternalLoginTransactionStore,
  type AuthSessionStore,
  type ExternalLoginTransactionStore,
  type ProjectRepository,
  type ProjectUnitOfWork,
} from "@starter/backend";
import type { AppType } from "@starter/backend/app-type";
import {
  assertMigrationsCurrent,
  createDatabaseResources,
  KyselyAuthSessionStore,
  KyselyExternalLoginTransactionStore,
  KyselyProjectRepository,
  KyselyProjectUnitOfWork,
  type DatabaseConnectionConfig,
  type DatabaseResources,
  type DatabaseSessionPolicy,
} from "@starter/database";
import { resolveAuthConfig } from "./auth-config.js";
import {
  createNodeApp,
  type CreateIdentityProvider,
  type IdentityProviderDependencies,
} from "./composition-root.js";
import {
  resolveDatabaseConfig,
  type DatabaseEnvironment,
  type ResolveDatabaseConfig,
} from "./database-config.js";
import { createSecretClient, type SecretClient } from "./database-password.js";
import { apiSessionPolicy } from "./database-session-policy.js";
import {
  createDatabaseClientErrorReporter,
  writeStdoutLine,
  type WriteLogLine,
} from "./error-log.js";
import { resolveNodeEnvironment } from "./node-environment.js";
import { createOidcIdentityProvider } from "./oidc-identity-provider.js";
import type { RedactedSecret } from "./redacted-secret.js";
import type { FixturePersistence, NodeScenario } from "./fixtures.js";

export type RuntimeComposition = {
  app: AppType;
  close(): Promise<void>;
};

export type RuntimeConfiguration = {
  nodeEnv: string | undefined;
  databaseEnvironment: DatabaseEnvironment;
  migrationsDirectory?: string | undefined;
  scenario?: string | undefined;
  authProvider?: string | undefined;
  appOrigin?: string | undefined;
  sessionAbsoluteTtlSeconds?: string | undefined;
  sessionIdleTtlSeconds?: string | undefined;
  sessionTouchIntervalSeconds?: string | undefined;
  oidcIssuer?: string | undefined;
  oidcClientId?: string | undefined;
  oidcClientSecret?: RedactedSecret | undefined;
  oidcLogoutEndpoint?: string | undefined;
  oidcLogoutRedirectParameter?: string | undefined;
  oidcLoginTransactionTtlSeconds?: string | undefined;
};

type RuntimeDependencies = {
  createSecretClient(): SecretClient;
  resolveDatabase: ResolveDatabaseConfig;
  openDatabase(options: {
    connection: DatabaseConnectionConfig;
    policy: DatabaseSessionPolicy;
    onClientError: (error: unknown) => void;
  }): DatabaseResources;
  writeLog: WriteLogLine;
  assertMigrations(
    pool: DatabaseResources["pool"],
    migrationsDirectory?: string,
  ): Promise<void>;
  createPostgresRepository(
    database: DatabaseResources["db"],
  ): ProjectRepository;
  createPostgresUnitOfWork(
    database: DatabaseResources["db"],
  ): ProjectUnitOfWork;
  createPostgresAuthStore(database: DatabaseResources["db"]): AuthSessionStore;
  createPostgresExternalLoginTransactionStore(
    database: DatabaseResources["db"],
  ): ExternalLoginTransactionStore;
  loadFixturePersistence(): Promise<
    (scenario: NodeScenario) => FixturePersistence
  >;
  createIdentityProvider: CreateIdentityProvider;
  identityProviderDependencies: IdentityProviderDependencies;
};

type ImportFixtures = () => Promise<{
  createFixturePersistence: (scenario: NodeScenario) => FixturePersistence;
}>;

const isModuleNotFound = (error: unknown): boolean =>
  error instanceof Error &&
  (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";

// 静的 import にするとテスト用フィクスチャが本番バンドルへ同梱されるため、
// ランタイムバンドルから外部化された動的 import 経由でのみ解決する。
// 本番イメージでは解決できないので、運用者に理由が伝わる形で fail closed させる。
export const loadFixturePersistence = async (
  importFixtures: ImportFixtures = () => import("./fixtures.js"),
): Promise<(scenario: NodeScenario) => FixturePersistence> => {
  try {
    return (await importFixtures()).createFixturePersistence;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    throw new Error(
      "NODE_ENV=test requires development-only fixtures that are excluded from the production runtime bundle",
      { cause: error },
    );
  }
};

const defaultDependencies: RuntimeDependencies = {
  createSecretClient,
  resolveDatabase: resolveDatabaseConfig,
  openDatabase: createDatabaseResources,
  writeLog: writeStdoutLine,
  assertMigrations: assertMigrationsCurrent,
  createPostgresRepository: (database) => new KyselyProjectRepository(database),
  createPostgresUnitOfWork: (database) => new KyselyProjectUnitOfWork(database),
  createPostgresAuthStore: (database) => new KyselyAuthSessionStore(database),
  createPostgresExternalLoginTransactionStore: (database) =>
    new KyselyExternalLoginTransactionStore(database),
  loadFixturePersistence: () => loadFixturePersistence(),
  createIdentityProvider: createOidcIdentityProvider,
  identityProviderDependencies: {},
};

const resolveScenario = (scenario: string | undefined): NodeScenario => {
  const value = scenario ?? "success";

  if (value !== "success" && value !== "empty" && value !== "error") {
    throw new Error("PROJECTS_SCENARIO must be success, empty, or error");
  }

  return value;
};

const connectivityError = () =>
  new Error(
    "Unable to connect to PostgreSQL. Check database availability and configuration.",
  );

export const createRuntimeComposition = async (
  configuration: RuntimeConfiguration,
  overrides: Partial<RuntimeDependencies> = {},
): Promise<RuntimeComposition> => {
  const nodeEnvironment = resolveNodeEnvironment(configuration.nodeEnv);
  const authConfig = resolveAuthConfig({
    NODE_ENV: nodeEnvironment,
    AUTH_PROVIDER: configuration.authProvider,
    APP_ORIGIN: configuration.appOrigin,
    SESSION_ABSOLUTE_TTL_SECONDS: configuration.sessionAbsoluteTtlSeconds,
    SESSION_IDLE_TTL_SECONDS: configuration.sessionIdleTtlSeconds,
    SESSION_TOUCH_INTERVAL_SECONDS: configuration.sessionTouchIntervalSeconds,
    OIDC_ISSUER: configuration.oidcIssuer,
    OIDC_CLIENT_ID: configuration.oidcClientId,
    OIDC_CLIENT_SECRET: configuration.oidcClientSecret?.reveal(),
    OIDC_LOGOUT_ENDPOINT: configuration.oidcLogoutEndpoint,
    OIDC_LOGOUT_REDIRECT_PARAMETER: configuration.oidcLogoutRedirectParameter,
    OIDC_LOGIN_TRANSACTION_TTL_SECONDS:
      configuration.oidcLoginTransactionTtlSeconds,
  });
  const dependencies = { ...defaultDependencies, ...overrides };

  if (nodeEnvironment === "test") {
    const scenario = resolveScenario(configuration.scenario);
    const createFixturePersistence =
      await dependencies.loadFixturePersistence();
    const { knownIdentities, repository, unitOfWork } =
      createFixturePersistence(scenario);
    return {
      app: createNodeApp({
        repository,
        unitOfWork,
        authStore: new InMemoryAuthSessionStore({ knownIdentities }),
        authConfig,
        externalLoginTransactionStore:
          new InMemoryExternalLoginTransactionStore(),
        createIdentityProvider: dependencies.createIdentityProvider,
        identityProviderDependencies: dependencies.identityProviderDependencies,
        writeLog: dependencies.writeLog,
      }),
      close: () => Promise.resolve(),
    };
  }

  // Secrets Manager の client はプロセスで 1 つ。pool が接続を張るたびに password を
  // 取り直すので、DB を閉じ終えるまで生かし、閉じたあとに destroy する。
  const secretClient = dependencies.createSecretClient();
  let resources: DatabaseResources;

  try {
    const connection = await dependencies.resolveDatabase(
      {
        nodeEnv: nodeEnvironment,
        databaseEnvironment: configuration.databaseEnvironment,
      },
      { secretClient },
    );
    try {
      resources = dependencies.openDatabase({
        connection,
        policy: apiSessionPolicy,
        onClientError: createDatabaseClientErrorReporter({
          write: dependencies.writeLog,
        }),
      });
    } catch {
      throw connectivityError();
    }
  } catch (error) {
    secretClient.destroy();
    throw error;
  }

  const closeResources = async () => {
    try {
      await resources.close();
    } finally {
      secretClient.destroy();
    }
  };

  try {
    try {
      await resources.pool.query("select 1");
    } catch {
      throw connectivityError();
    }
    // migrate.ts と同じく前後空白を落とし、空文字なら既定ディレクトリへ委ねる。
    const migrationsDirectory = configuration.migrationsDirectory?.trim();
    await dependencies.assertMigrations(
      resources.pool,
      migrationsDirectory === "" ? undefined : migrationsDirectory,
    );

    const repository = dependencies.createPostgresRepository(resources.db);
    const unitOfWork = dependencies.createPostgresUnitOfWork(resources.db);
    const authStore = dependencies.createPostgresAuthStore(resources.db);
    const externalLoginTransactionStore =
      dependencies.createPostgresExternalLoginTransactionStore(resources.db);
    return {
      app: createNodeApp({
        repository,
        unitOfWork,
        authStore,
        authConfig,
        externalLoginTransactionStore,
        createIdentityProvider: dependencies.createIdentityProvider,
        identityProviderDependencies: dependencies.identityProviderDependencies,
        writeLog: dependencies.writeLog,
      }),
      close: closeResources,
    };
  } catch (error) {
    try {
      await closeResources();
    } catch {
      // 安全な形に整えた起動エラーを残し、後片付けの詳細で上書きしない。
    }
    throw error;
  }
};
