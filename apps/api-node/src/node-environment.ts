export type NodeEnvironment = "development" | "production" | "test";

// NODE_ENV の解釈はデータベース・認証・テレメトリのすべてが共有する。
// 受理する値を1箇所に閉じておかないと、片方だけ緩めた設定が起動時に食い違う。
export const resolveNodeEnvironment = (
  nodeEnv: string | undefined,
): NodeEnvironment => {
  const value = nodeEnv?.trim() ?? "development";

  if (value !== "development" && value !== "production" && value !== "test") {
    throw new Error("NODE_ENV must be development, production, or test");
  }

  return value;
};
