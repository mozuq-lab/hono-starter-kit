import { authUrls } from "@starter/api-client";
import { type ClientLoaderFunctionArgs, useLoaderData } from "react-router";
import {
  alertBoxClass,
  alertMessageClass,
  primaryButtonClass,
} from "../components/ui-classes.js";

export function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const { searchParams } = new URL(request.url);
  const returnTo = searchParams.get("returnTo") ?? undefined;
  // /auth/callback はどの失敗でもこの値だけを付けて戻す。知らない値は表示しない（クエリは
  // 誰でも付けられるので、文字列を画面へそのまま出さない）。
  const signInFailed = searchParams.get("error") === "authentication_failed";

  // 検証は /auth/login を受けるサーバー（resolveReturnTo）の責務で、ここでは通すだけにする。
  // 生成するのは常に同一オリジンの /auth/login なので、未検証の値を載せても遷移先は変わらない。
  // 規則を持つ場所が 2 つあると、片方だけ直したときにログイン後の遷移先がずれる。
  return { loginUrl: authUrls.login(returnTo), signInFailed };
}

export default function LoginRoute() {
  const { loginUrl, signInFailed } = useLoaderData<typeof clientLoader>();

  return (
    <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-10 shadow-lg dark:border-slate-800 dark:bg-slate-900">
        <p className="mb-2 text-xs font-extrabold uppercase tracking-widest text-blue-600 dark:text-blue-400">
          Hono Starter Kit
        </p>
        <h1 className="mb-2 text-3xl font-extrabold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Continue with the configured identity provider.
        </p>
        {signInFailed ? (
          <p
            className={`${alertBoxClass} ${alertMessageClass} mt-4`}
            role="alert"
          >
            Sign-in could not be completed. Please try again.
          </p>
        ) : null}
        <a className={`${primaryButtonClass} mt-4`} href={loginUrl}>
          Sign in
        </a>
      </section>
    </main>
  );
}
