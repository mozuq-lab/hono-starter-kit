import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export type SecretClient = {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
  destroy(): void;
};

// SDK の client は認証情報（ECS のコンテナ認証情報エンドポイントから取るもの）と
// HTTP keep-alive の接続を client 単位で持つ。接続ごとに作ると、そのたびに認証情報の取得と
// TLS ハンドシェイクが走るので、プロセスで 1 つだけ作り、DB を閉じたあとに destroy する。
export const createSecretClient = (): SecretClient =>
  new SecretsManagerClient({});

export const createDatabasePassword =
  (
    { secretArn, user }: { secretArn: string; user: string },
    { client }: { client: SecretClient },
  ): (() => Promise<string>) =>
  async () => {
    try {
      // pg が新規接続時に呼ぶため、値を保持すると RDS rotation 後も古い password を使い続ける。
      const response = await client.send(
        new GetSecretValueCommand({
          SecretId: secretArn,
          VersionStage: "AWSCURRENT",
        }),
      );
      if (typeof response.SecretString !== "string") throw new Error();
      const secret: unknown = JSON.parse(response.SecretString);
      if (
        secret === null ||
        typeof secret !== "object" ||
        Array.isArray(secret) ||
        !("username" in secret) ||
        secret.username !== user ||
        !("password" in secret) ||
        typeof secret.password !== "string" ||
        secret.password.trim() === ""
      ) {
        throw new Error();
      }
      return secret.password;
    } catch {
      // SDK の診断や JSON.parse の入力断片を cause にも残さず、CLI と接続失敗経路を安全にする。
      throw new Error(
        "Unable to retrieve PostgreSQL password from Secrets Manager.",
      );
    }
  };
