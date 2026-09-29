import { ApiError, UnexpectedApiResponseError } from "@starter/api-client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { redirect } from "react-router";

/**
 * セッション切れは初回ロードだけでなく再取得やミューテーションでも起きるため、
 * 401 の検知とログイン画面への誘導をこのモジュールに集約する。
 */
export const isSessionExpired = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;

const loginPath = (location: { pathname: string; search: string }): string =>
  `/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

/**
 * 少し待てば直る可能性がある失敗だけを true にする。対象はネットワーク断（fetch の `TypeError`）と、
 * Problem 形式でない 5xx（ALB やプロキシの 502/503 など）。
 *
 * `ApiError` はサーバーが意図して返した Problem なので再試行しない（401 のログイン誘導も遅らせない）。
 * `status < 500` の `UnexpectedApiResponseError` は、schema に合わない 2xx の成功応答を含む契約違反で、
 * 再試行しても直らない。
 */
export const isTransientFailure = (error: unknown): boolean =>
  !(error instanceof ApiError) &&
  !(error instanceof UnexpectedApiResponseError && error.status < 500);

/**
 * 背景の再取得用の再試行方針。`useQuery` にだけ渡し、1 回だけ再試行する。
 * loader の `fetchQuery` には渡さない。初回取得は再試行せず、失敗を Retry ボタンで見せる
 * （すぐ失敗を見せて手動で回復できることが spec）。
 */
export const retryTransientFailureOnce = (
  failureCount: number,
  error: unknown,
): boolean => failureCount < 1 && isTransientFailure(error);

/** 全画面遷移だけを境界として切り出し、テストから差し替えられるようにする。 */
export const sessionNavigation = {
  assign(path: string): void {
    window.location.assign(path);
  },
};

/**
 * loader / clientAction 用。React Router に Response を投げて /login へ送る。
 * ソフト遷移でモジュール状態は残るため、後続の 401 を抑止するフラグは立てない。
 * 呼び出し側が自分の QueryClient を持ち回っている場合は、そのキャッシュを捨てる。
 */
export function redirectToLogin(
  requestUrl: string,
  client: QueryClient = queryClient,
): never {
  client.clear();
  // React Router の loader はリダイレクトを Response の throw で表す。
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect(loginPath(new URL(requestUrl)));
}

// 同じ期限切れで 401 が同時多発しても全画面遷移は一度だけにする。
// 遷移が起きずにタブが生き続けた場合に備え、次のマイクロタスクで抑止を解く。
let sessionExpiryRedirecting = false;

const claimSessionExpiryRedirect = (): boolean => {
  if (sessionExpiryRedirecting) return false;
  sessionExpiryRedirecting = true;
  queueMicrotask(() => {
    sessionExpiryRedirecting = false;
  });
  return true;
};

/** TanStack Query 用。ルーター外から検知するため全画面遷移で送る。 */
const redirectToLoginOnSessionExpiry = (error: unknown): void => {
  if (!isSessionExpired(error) || !claimSessionExpiryRedirect()) return;
  queryClient.clear();
  sessionNavigation.assign(loginPath(window.location));
};

export const queryClient = new QueryClient({
  // retry は既定では false のままにする。loader の初回取得（fetchQuery）が再試行すると、
  // 遷移が止まり Retry ボタンの UX も変わる。背景の再取得は各ルートの useQuery が
  // retryTransientFailureOnce で 1 回だけ再試行する。
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  mutationCache: new MutationCache({ onError: redirectToLoginOnSessionExpiry }),
  queryCache: new QueryCache({ onError: redirectToLoginOnSessionExpiry }),
});
