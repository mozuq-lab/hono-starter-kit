/**
 * API ポートの解決だけを持つ独立モジュール。ビルド設定（vite.config.ts）と
 * E2E ハーネスの両方が読むため、spawn や net といった実行時依存を持ち込まない。
 */
export const DEFAULT_API_PORT = 3000;

export const resolveApiPort = (
  environment: Record<string, string | undefined>,
): number => {
  const configured = environment.E2E_API_PORT;
  if (configured === undefined || configured === "") return DEFAULT_API_PORT;

  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `E2E_API_PORT must be an integer between 1 and 65535, received "${configured}".`,
    );
  }

  return port;
};
