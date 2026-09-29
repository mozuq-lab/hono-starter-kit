import { randomUUID } from "node:crypto";
import {
  createAuthenticateSession,
  createApp,
  createArchiveProject,
  createBeginExternalLogin,
  createCompleteExternalLogin,
  createCreateProject,
  createDevLoginRoutes,
  createEstablishSession,
  createExternalLoginRoutes,
  createGetProject,
  createListProjects,
  createRevokeSession,
  createUpdateProject,
  type AuthSessionStore,
  type ExternalIdentityProvider,
  type ExternalLoginTransactionStore,
  type ProjectRepository,
  type ProjectUnitOfWork,
} from "@starter/backend";
import type { AppType } from "@starter/backend/app-type";
import type { AuthConfig, OidcAuthConfig } from "./auth-config.js";
import {
  createSuppressedErrorReporter,
  writeStdoutLine,
  type WriteLogLine,
} from "./error-log.js";
import {
  generateSessionId,
  generateUserId,
  hashValue,
  hashSessionId,
} from "./session-crypto.js";
import {
  createOidcIdentityProvider,
  type OidcIdentityProviderDependencies,
} from "./oidc-identity-provider.js";
import { createRequestObserver } from "./request-observer.js";

export type IdentityProviderDependencies = OidcIdentityProviderDependencies;

// これは OIDC プロバイダの生成方法だけを差し替える seam であり、OCP の解決ではない。
// プロバイダ種別を増やすには resolveProvider の union と AuthConfig 判別ユニオン、
// そして下の provider === "dev" 三項分岐そのものを広げる必要が残っている。
export type CreateIdentityProvider = (
  config: OidcAuthConfig["oidc"],
  dependencies: IdentityProviderDependencies,
) => ExternalIdentityProvider;

export const createNodeApp: ({
  repository,
  unitOfWork,
  authStore,
  authConfig,
  externalLoginTransactionStore,
  createIdentityProvider,
  identityProviderDependencies,
  writeLog,
}: {
  repository: ProjectRepository;
  unitOfWork: ProjectUnitOfWork;
  authStore: AuthSessionStore;
  authConfig: AuthConfig;
  externalLoginTransactionStore: ExternalLoginTransactionStore;
  createIdentityProvider?: CreateIdentityProvider;
  identityProviderDependencies?: IdentityProviderDependencies;
  /**
   * 構造化ログの書き出し先。想定外エラーのログも、握りつぶした例外のログ
   * （createSuppressedErrorReporter）も、同じ書き出し先を使う。
   */
  writeLog?: WriteLogLine;
}) => AppType = ({
  repository,
  unitOfWork,
  authStore,
  authConfig,
  externalLoginTransactionStore,
  createIdentityProvider = createOidcIdentityProvider,
  identityProviderDependencies = {},
  writeLog = writeStdoutLine,
}) => {
  const clock = () => new Date();
  const establishSession = createEstablishSession({
    clock,
    generateSessionId,
    generateUserId,
    hashSessionId,
    policy: authConfig.policy,
    reportSuppressedError: createSuppressedErrorReporter({ write: writeLog }),
    store: authStore,
  });
  const authenticateSession = createAuthenticateSession({
    clock,
    hashSessionId,
    policy: authConfig.policy,
    store: authStore,
  });
  const revokeSession = createRevokeSession({
    hashSessionId,
    store: authStore,
  });
  const loginRoutes =
    authConfig.provider === "dev"
      ? createDevLoginRoutes({
          establishSession,
          sessionCookie: authConfig.cookie,
        })
      : (() => {
          const provider = createIdentityProvider(
            authConfig.oidc,
            identityProviderDependencies,
          );
          return createExternalLoginRoutes({
            beginExternalLogin: createBeginExternalLogin({
              clock,
              hash: hashValue,
              provider,
              redirectUri: authConfig.oidc.redirectUri,
              store: externalLoginTransactionStore,
              ttlMs: authConfig.transactionTtlMs,
            }),
            completeExternalLogin: createCompleteExternalLogin({
              clock,
              hash: hashValue,
              provider,
              redirectUri: authConfig.oidc.redirectUri,
              store: externalLoginTransactionStore,
            }),
            establishSession,
            providerLogoutUrl: provider.logoutUrl({
              postLogoutRedirectUri: authConfig.oidc.postLogoutRedirectUri,
            }),
            redirectUri: authConfig.oidc.redirectUri,
            sessionCookie: authConfig.cookie,
            transactionCookie: authConfig.transactionCookie,
          });
        })();

  return createApp({
    createProject: createCreateProject({
      clock,
      generateId: () => randomUUID(),
      unitOfWork,
    }),
    updateProject: createUpdateProject({
      clock,
      unitOfWork,
    }),
    archiveProject: createArchiveProject({
      clock,
      unitOfWork,
    }),
    getProject: createGetProject(repository),
    listProjects: createListProjects(repository),
    allowedOrigin: authConfig.appOrigin,
    authenticateSession,
    loginRoutes,
    revokeSession,
    sessionCookie: authConfig.cookie,
    observeRequest: createRequestObserver({ write: writeLog }),
  });
};
