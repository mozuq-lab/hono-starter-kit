import type { createApp } from "./create-app.js";

export type AppType = ReturnType<typeof createApp>;

/**
 * 公開する AppType。非 2xx の形は api-client が `problemSchema` で実行時に検証するので、
 * 型としては Route 定義から推論されたものをそのまま出す。
 */
export type PublicAppType = AppType;
