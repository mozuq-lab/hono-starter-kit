import { z } from "zod";

/**
 * ブラウザへ渡してよい認証済みユーザの表現。`strict()` にしてあるのは、
 * プロバイダのトークンや生のクレームが将来うっかり足されたときに、
 * 気づかず外へ出るのではなく検証で落とすため。
 *
 * `email` と `displayName` はプロバイダが返さないことがあるので任意。
 * 表示に使うなら未設定の場合を必ず用意すること。
 */
export const authenticatedUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.email().optional(),
    displayName: z.string().min(1).optional(),
    roles: z.array(z.string().min(1)),
  })
  .strict();

/**
 * `GET /api/me` の応答。未認証なら本文ではなく `UNAUTHENTICATED` の Problem が返るので、
 * この形が返った時点で認証済みとみなしてよい。
 */
export const meResponseSchema = z
  .object({ user: authenticatedUserSchema })
  .strict();

/** 認証済みユーザ。{@link authenticatedUserSchema} の推論型。 */
export type AuthenticatedUserDto = z.infer<typeof authenticatedUserSchema>;
/** `GET /api/me` の応答。{@link meResponseSchema} の推論型。 */
export type MeResponse = z.infer<typeof meResponseSchema>;
