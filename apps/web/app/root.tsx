import { ApiError } from "@starter/api-client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRevalidator,
  useRouteError,
} from "react-router";
import type { Route } from "./+types/root";
import { AppLoading } from "./components/app-loading.js";
import stylesheet from "./styles.css?url";
import { queryClient } from "./lib/query-client.js";

export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
];

export function Layout({ children }: { children: ReactElement }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return <AppLoading />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}

/** どのルートにも拾われなかったエラーの受け皿。内部詳細は出さず requestId だけ渡す。 */
export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  return (
    <main>
      <h1>問題が発生しました。</h1>
      <div role="alert">
        <p>ページを表示できませんでした。</p>
        {requestId ? (
          <p>
            Request ID: <code>{requestId}</code>
          </p>
        ) : null}
      </div>
      <button type="button" onClick={() => void revalidator.revalidate()}>
        再試行
      </button>
    </main>
  );
}
