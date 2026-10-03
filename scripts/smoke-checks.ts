import { readFile } from "node:fs/promises";

// pnpm smoke:dev の検査本体。デプロイ済みの dev 環境で、ローカルの Vite プロキシでは見つからない
// CloudFront・ALB・キャッシュポリシーの食い違いを、HTTP と DNS だけで確かめる。

export type SecurityHeaders = Readonly<Record<string, string>>;

const edgeMain = new URL(
  "../infra/terraform/modules/edge/main.tf",
  import.meta.url,
);

const capture = (source: string, pattern: RegExp, label: string): string => {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) {
    throw new Error(
      `Cannot read ${label} from the edge response headers policy.`,
    );
  }
  return value;
};

// ヘッダーの値を二重に書かないよう、期待値は Terraform から読む。書式が変わって読めないときは
// 検査を黙って緩めず、検査を始める前に止める。
export const readExpectedSecurityHeaders = (
  terraformSource: string,
): SecurityHeaders => {
  const policy = capture(
    terraformSource,
    /resource\s+"aws_cloudfront_response_headers_policy"\s+"security"\s*\{([\s\S]*?)\n\}/u,
    "the security policy",
  );
  if (!/content_type_options\s*\{/u.test(policy)) {
    throw new Error(
      "Cannot read content_type_options from the edge response headers policy.",
    );
  }
  const maxAge = capture(
    policy,
    /access_control_max_age_sec\s*=\s*(\d+)/u,
    "access_control_max_age_sec",
  );
  const includeSubdomains =
    capture(
      policy,
      /include_subdomains\s*=\s*(true|false)/u,
      "include_subdomains",
    ) === "true";
  const preload =
    capture(policy, /preload\s*=\s*(true|false)/u, "preload") === "true";

  return {
    "content-security-policy": capture(
      policy,
      /content_security_policy\s*=\s*"([^"]+)"/u,
      "content_security_policy",
    ),
    "x-content-type-options": "nosniff",
    "x-frame-options": capture(
      policy,
      /frame_option\s*=\s*"([^"]+)"/u,
      "frame_option",
    ),
    "referrer-policy": capture(
      policy,
      /referrer_policy\s*=\s*"([^"]+)"/u,
      "referrer_policy",
    ),
    "strict-transport-security": [
      `max-age=${maxAge}`,
      ...(includeSubdomains ? ["includeSubDomains"] : []),
      ...(preload ? ["preload"] : []),
    ].join("; "),
  };
};

export const loadExpectedSecurityHeaders = async (): Promise<SecurityHeaders> =>
  readExpectedSecurityHeaders(await readFile(edgeMain, "utf8"));
