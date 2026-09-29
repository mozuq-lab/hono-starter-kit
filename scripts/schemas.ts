import { z } from "zod";

/**
 * 外部入力の形。
 *
 * ここにあるのは「形」だけで、業務上の規則は各呼び出し元に残してある。規則側の
 * エラーメッセージは差分の中身まで含めてテストが固定しており、スキーマライブラリの
 * 既定メッセージでは再現できないため。
 *
 * したがって検証の失敗メッセージはこれらのスキーマからは出さない。正しい入力に型を
 * 与えるのが役目で、壊れた入力は呼び出し元の既存チェックが従来どおりの文言で落とす。
 */

/** package.json として読んだもの。項目の有無は読む側が確かめる。 */
export const packageManifestSchema = z.record(z.string(), z.unknown());

/** Production image のコンテナ内で作られる検査スナップショット。 */
export const runtimeSnapshotSchema = z.object({
  appRoot: z.string(),
  appEntries: z.array(z.string()),
  dependencyProblems: z.array(z.string()),
  installedPackages: z.array(z.object({ name: z.string(), path: z.string() })),
  packageManifest: packageManifestSchema,
  rdsCa: z.object({
    appendErrorCode: z.string(),
    chmodErrorCode: z.string(),
    directory: z.object({
      gid: z.number(),
      mode: z.number(),
      path: z.string(),
      uid: z.number(),
    }),
    gid: z.number(),
    inspector: z.object({
      gid: z.number().optional(),
      uid: z.number().optional(),
    }),
    mode: z.number(),
    path: z.string(),
    replaceErrorCode: z.string(),
    sha256: z.string(),
    uid: z.number(),
    unlinkErrorCode: z.string(),
  }),
  repositoryEntries: z.array(z.object({ path: z.string(), type: z.string() })),
});

/**
 * `aws ecr describe-images --output json` の応答。digest の形はここで確かめ、
 * 件数（tag 1 つに image 1 つ）は呼び出し元が確かめる。
 */
export const ecrDescribeImagesSchema = z.object({
  imageDetails: z.array(
    z.object({ imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u) }),
  ),
});

export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
