import { meResponseSchema, type MeResponse } from "@starter/contracts";
import { UnexpectedApiResponseError } from "./errors.js";
import { createRpcClient } from "./client.js";
import { parsePayload, parseSuccess } from "./response.js";

type ClientOptions = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
};

/**
 * fetch ではなくページ遷移で到達するエンドポイント。リダイレクトを伴うので
 * fetch では成立しないが、これも wire contract の一部なのでパスはこのパッケージが持つ。
 *
 * `login` の `returnTo` はサーバ側で同一オリジンの相対パスに丸められる。
 * 外部 URL を渡しても既定の遷移先に置き換わる。
 */
export const authUrls = {
  login: (returnTo?: string): string =>
    returnTo === undefined
      ? "/auth/login"
      : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  providerLogout: (): string => "/auth/provider-logout",
} as const;

/**
 * 認証まわりのクライアントを作る。セッションは Cookie で運ぶので、
 * リクエストはすべて `credentials: "same-origin"` で送る。
 *
 * @param baseUrl API のオリジン。
 * @param fetch 使用する fetch 実装。テストや SSR で差し替える。
 */
export const createAuthClient = ({
  baseUrl,
  fetch: fetchImpl,
}: ClientOptions): {
  /**
   * 認証済みユーザを取得する。
   *
   * @throws {ApiError} 未認証なら `UNAUTHENTICATED`。ログイン判定にはこれを捕まえる。
   * @throws {UnexpectedApiResponseError} 応答が契約に合わないとき。
   */
  getMe(): Promise<MeResponse>;
  /**
   * このアプリのセッションを破棄する。すでに未認証でも成功として扱う。
   *
   * 破棄されるのはアプリ側のセッションだけで、ID プロバイダ側は残る。
   * プロバイダからも切るなら、続けて `authUrls.providerLogout()` へ遷移させること。
   */
  logout(): Promise<void>;
} => {
  const rpc = createRpcClient({ baseUrl, fetch: fetchImpl });
  return {
    async getMe(): Promise<MeResponse> {
      const response = await rpc.api.me.$get();
      return parseSuccess(
        await parsePayload(response),
        meResponseSchema,
        response.status,
      );
    },

    async logout(): Promise<void> {
      const response = await rpc.auth.logout.$post();
      if (response.status === 204) return;
      if (response.ok) throw new UnexpectedApiResponseError(response.status);
      await parsePayload(response);
    },
  };
};
