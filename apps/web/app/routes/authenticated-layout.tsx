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
      <header className="app-header">
        <Link className="app-title" to="/projects">
          Hono Starter Kit
        </Link>
        <nav aria-label="Primary">
          <Link to="/projects">Projects</Link>
        </nav>
        <div className="session-controls">
          <span>{userName}</span>
          <button
            aria-busy={logoutPending}
            disabled={logoutPending}
            onClick={() => void logout()}
            type="button"
          >
            Sign out
          </button>
        </div>
        {logoutFailed ? (
          <p className="logout-error" role="alert">
            Sign out failed. Please try again.
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
