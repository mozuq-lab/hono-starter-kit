import { isKnownProblemCode, meResponseSchema } from "@starter/contracts";
import { Hono, type Context, type Hono as HonoType } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { CreateProject } from "../modules/projects/create-project.js";
import type { ArchiveProject } from "../modules/projects/archive-project.js";
import type { GetProject } from "../modules/projects/get-project.js";
import type { ListProjects } from "../modules/projects/list-projects.js";
import type { UpdateProject } from "../modules/projects/update-project.js";
import { createProjectRoutes } from "../modules/projects/project.routes.js";
import type { AuthenticateSession } from "../platform/auth/authenticate-session.js";
import { createAuthenticationMiddleware } from "../platform/auth/auth.middleware.js";
import { createOriginMiddleware } from "../platform/auth/origin.middleware.js";
import type { RevokeSession } from "../platform/auth/revoke-session.js";
import { createSessionRoutes } from "../platform/auth/session.routes.js";
import type { SessionCookieConfig } from "../platform/auth/session-cookie.js";
import { ApplicationError } from "../platform/errors/application-error.js";
import type { AppEnv } from "./app-env.js";
import { problemResponse } from "./problem.js";
import { requestIdMiddleware } from "./request-id.js";
import {
  createRequestObserverMiddleware,
  ignoreRequestOutcome,
  type ObserveRequest,
} from "./request-observer.js";

// 最大の本文は Project 名（100 文字）の JSON で、1 KiB にも届かない。OIDC のコールバックは
// GET なので本文を持たない。Hono の JSON 検証も @hono/node-server も本文を丸ごと読み、
// 既定の上限はないので、これがないとログイン済みの利用者が巨大な本文でメモリを食い尽くせる。
// 環境変数にしないのは、設定の組み合わせを増やさないため。
export const requestBodyLimitBytes = 100 * 1024;

export const createApp = ({
  createProject,
  archiveProject,
  getProject,
  listProjects,
  updateProject,
  allowedOrigin,
  authenticateSession,
  loginRoutes,
  revokeSession,
  sessionCookie,
  observeRequest = ignoreRequestOutcome,
}: {
  createProject: CreateProject;
  archiveProject: ArchiveProject;
  getProject: GetProject;
  listProjects: ListProjects;
  updateProject: UpdateProject;
  allowedOrigin: string;
  authenticateSession: AuthenticateSession;
  loginRoutes: HonoType<AppEnv>;
  revokeSession: RevokeSession;
  sessionCookie: SessionCookieConfig;
  /** 要求ごとに 1 回呼ばれる。想定外の失敗の記録とトレースの route 付けに使う。 */
  observeRequest?: ObserveRequest;
}) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware);
  // Request ID の直後に置き、以降の middleware（本文の上限、認証）で起きた失敗も観測する。
  app.use("*", createRequestObserverMiddleware(observeRequest));
  // 認証より前に置き、未認証の要求にもセッション参照の前で本文の上限を効かせる。
  app.use(
    "*",
    bodyLimit({
      maxSize: requestBodyLimitBytes,
      // bodyLimit の onError は Env を持たない Context で宣言されているので、AppEnv を明示する。
      onError: (context: Context<AppEnv>) =>
        problemResponse(context, "PAYLOAD_TOO_LARGE"),
    }),
  );
  // 連鎖させずに登録し、戻り値の型（RPC の AppType）を変えない。
  app.notFound((context) => problemResponse(context, "NOT_FOUND"));
  app.onError((error, context) => {
    // ApplicationError で絞るので、`code` を持つ別のエラー（pg の SQLSTATE など）を
    // Problem のコードと取り違えない。契約にないコードは下の 500 に落とす。
    if (error instanceof ApplicationError && isKnownProblemCode(error.code)) {
      return problemResponse(context, error.code, {
        fieldErrors: error.fieldErrors,
      });
    }

    // 本文が JSON として壊れている場合、Hono の validator は hook を通さず
    // HTTPException(400) を投げるので、ここで受けて他の検証失敗と同じ Problem に揃える。
    //
    // 状態だけで判定しないのは、同じ validator が form ターゲットでも 400 を投げるため。
    // それを取り違えると、FormData の失敗に JSON 本文のフィールド名を付けて返すことになる。
    // Hono 側でこの文言が変われば malformed JSON の既存テストが落ちて気づける。
    if (
      error instanceof HTTPException &&
      error.status === 400 &&
      error.message === "Malformed JSON in request body"
    ) {
      return problemResponse(context, "VALIDATION_ERROR", {
        fieldErrors: { body: ["Request body must be valid JSON."] },
      });
    }

    return problemResponse(context, "INTERNAL_ERROR");
  });

  const authenticationMiddleware = createAuthenticationMiddleware({
    authenticateSession,
    sessionCookie,
  });
  const originMiddleware = createOriginMiddleware({ allowedOrigin });
  const projectDependencies = {
    createProject,
    archiveProject,
    getProject,
    listProjects,
    updateProject,
  };

  return app
    .get("/healthz", (context) => context.json({ status: "ok" as const }, 200))
    .route("/auth", loginRoutes)
    .use("/auth/*", originMiddleware)
    .route("/auth", createSessionRoutes({ revokeSession, sessionCookie }))
    .use("/api/*", authenticationMiddleware)
    .use("/api/*", originMiddleware)
    .get("/api/me", (context) => {
      const body = meResponseSchema.parse({
        user: context.get("authenticatedUser"),
      });
      return context.json(body, 200);
    })
    .route("/api/projects", createProjectRoutes(projectDependencies));
};
