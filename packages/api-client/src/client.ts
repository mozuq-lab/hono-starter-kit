import type { PublicAppType } from "@starter/backend/app-type";
import { hc } from "hono/client";

export const createRpcClient = ({
  baseUrl,
  fetch: fetchImpl,
}: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
}) =>
  hc<PublicAppType>(baseUrl, {
    fetch: fetchImpl,
    // セッションは Cookie で運ぶ。fetch の既定値に頼らず、ここで固定する。
    init: { credentials: "same-origin" },
  });
