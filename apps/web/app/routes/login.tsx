import { authUrls } from "@starter/api-client";
import { type ClientLoaderFunctionArgs, useLoaderData } from "react-router";

export function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const returnTo =
    new URL(request.url).searchParams.get("returnTo") ?? undefined;

  // 検証は /auth/login を受けるサーバー（resolveReturnTo）の責務で、ここでは通すだけにする。
  // 生成するのは常に同一オリジンの /auth/login なので、未検証の値を載せても遷移先は変わらない。
  // 規則を持つ場所が 2 つあると、片方だけ直したときにログイン後の遷移先がずれる。
  return { loginUrl: authUrls.login(returnTo) };
}

export default function LoginRoute() {
  const { loginUrl } = useLoaderData<typeof clientLoader>();

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Hono Starter Kit</p>
        <h1>Sign in</h1>
        <p>Continue with the configured identity provider.</p>
        <a className="primary-link" href={loginUrl}>
          Sign in
        </a>
      </section>
    </main>
  );
}
