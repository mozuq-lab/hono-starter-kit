import { useRef, useState } from "react";
import {
  Link,
  Outlet,
  type ClientLoaderFunctionArgs,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "react-router";
import { ApiError, authUrls } from "@starter/api-client";
import { AppErrorView } from "../components/app-error-view.js";
import {
  alertBoxClass,
  alertMessageClass,
  ghostButtonClass,
} from "../components/ui-classes.js";
import { authClient } from "../lib/api-client.js";
import {
  isSessionExpired,
  queryClient,
  redirectToLogin,
} from "../lib/query-client.js";

type CurrentUserClient = Pick<typeof authClient, "getMe">;

export const createAuthenticatedLoader = (auth: CurrentUserClient) =>
  async function authenticatedLoader({ request }: ClientLoaderFunctionArgs) {
    try {
      return await auth.getMe();
    } catch (error) {
      // 期限切れだけをログインへ送る。通信断や 5xx まで送ると、
      // 認証は生きているのにログイン画面へ飛ばされて原因が見えなくなる。
      // それらは再送出して ErrorBoundary に再試行を出させる。
      if (isSessionExpired(error)) redirectToLogin(request.url);
      throw error;
    }
  };

const loadAuthenticatedUser = createAuthenticatedLoader(authClient);

export async function clientLoader(args: ClientLoaderFunctionArgs) {
  return loadAuthenticatedUser(args);
}
clientLoader.hydrate = true as const;

type AuthenticatedLayoutProps = {
  navigateToProviderLogout?: () => void;
};

const navigateToProviderLogoutByDefault = () => {
  window.location.assign(authUrls.providerLogout());
};

function AuthenticatedLayout({
  navigateToProviderLogout = navigateToProviderLogoutByDefault,
}: AuthenticatedLayoutProps = {}) {
  const { user } = useLoaderData<typeof clientLoader>();
  const logoutInFlight = useRef(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);

  const logout = async () => {
    if (logoutInFlight.current) return;

    logoutInFlight.current = true;
    setLogoutPending(true);
    setLogoutFailed(false);

    try {
      await authClient.logout();
      queryClient.clear();
      navigateToProviderLogout();
    } catch {
      setLogoutFailed(true);
    } finally {
      logoutInFlight.current = false;
      setLogoutPending(false);
    }
  };

  const userName = user.displayName ?? user.email ?? user.id;

  return (
    <>
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 bg-white/90 px-6 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <Link
          className="inline-flex items-center gap-2 text-base font-extrabold text-slate-900 no-underline dark:text-slate-100"
          to="/projects"
        >
          <span
            aria-hidden="true"
            className="h-3 w-3 rounded-full bg-blue-600 dark:bg-blue-400"
          />
          Hono Starter Kit
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-1">
          <Link
            className="rounded-full px-3 py-1.5 text-sm font-semibold text-slate-500 no-underline hover:bg-blue-50 hover:text-blue-700 dark:text-slate-400 dark:hover:bg-blue-950 dark:hover:text-blue-300"
            to="/projects"
          >
            Projects
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <span className="max-w-64 truncate rounded-full bg-blue-50 px-3 py-1 text-sm font-semibold text-slate-700 dark:bg-blue-950 dark:text-slate-200">
            {userName}
          </span>
          <button
            aria-busy={logoutPending}
            className={ghostButtonClass}
            disabled={logoutPending}
            onClick={() => void logout()}
            type="button"
          >
            Sign out
          </button>
        </div>
        {logoutFailed ? (
          <p className={`${alertBoxClass} w-full`} role="alert">
            <span className={alertMessageClass}>
              Sign out failed. Please try again.
            </span>
          </p>
        ) : null}
      </header>
      <Outlet />
    </>
  );
}

export default AuthenticatedLayout;

export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  return (
    <AppErrorView
      requestId={requestId}
      onRetry={() => void revalidator.revalidate()}
    />
  );
}
