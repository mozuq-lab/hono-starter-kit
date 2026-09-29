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
import {
  alertBoxClass,
  alertCodeClass,
  alertDetailClass,
  alertMessageClass,
  pageMainClass,
  pageTitleClass,
  primaryButtonClass,
} from "./components/ui-classes.js";
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
      <body className="bg-slate-100 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
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
    <main className={`${pageMainClass} text-center`}>
      <h1 className={pageTitleClass}>問題が発生しました。</h1>
      <div className={`${alertBoxClass} text-left`} role="alert">
        <p className={alertMessageClass}>ページを表示できませんでした。</p>
        {requestId ? (
          <p className={alertDetailClass}>
            Request ID: <code className={alertCodeClass}>{requestId}</code>
          </p>
        ) : null}
      </div>
      <button
        className={`${primaryButtonClass} mt-4`}
        type="button"
        onClick={() => void revalidator.revalidate()}
      >
        再試行
      </button>
    </main>
  );
}
