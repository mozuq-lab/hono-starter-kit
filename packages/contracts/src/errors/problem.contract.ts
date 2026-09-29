import { z } from "zod";

/**
 * エラー応答の形（RFC 9457 の Problem Details）。エラー時の本文はすべてこれになる。
 *
 * 分岐に使うのは `type` ではなく `code`。`requestId` は必ず入るので、
 * ユーザ向けの表示やサポートへの問い合わせにはこれを添えること。
 * `fieldErrors` は入力検証で落ちたときだけ入る。
 */
export const problemSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().min(1),
  requestId: z.string().min(1),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});

/** エラー応答の本文。{@link problemSchema} の推論型。 */
export type Problem = z.infer<typeof problemSchema>;

/**
 * どの API からでも返り得る Problem の type URI。送る側と受け取る側の両方がここから読むので、
 * URI をパッケージ境界をまたいで書き写す必要がない。
 *
 * ここにコードを足すと、全モジュールの画面の網羅分岐に文言を書く必要が生じる。
 * 発行する箇所ができてから足すこと。
 */
export const platformProblemTypes = {
  INTERNAL_ERROR: "https://starter.local/problems/internal-server-error",
  UNAUTHENTICATED: "https://starter.local/problems/unauthenticated",
  ORIGIN_NOT_ALLOWED: "https://starter.local/problems/origin-not-allowed",
  VALIDATION_ERROR: "https://starter.local/problems/validation-error",
  /**
   * 要求したパスやメソッドに対応する API がない。特定の資源が見つからないことを表す
   * モジュールのコード（`PROJECT_NOT_FOUND` など）とは別で、デプロイ中に新しい画面が
   * 古い API を呼んだときやメソッドを取り違えたときに返る。
   */
  NOT_FOUND: "https://starter.local/problems/not-found",
  /** 要求の本文が API の受け付ける上限（100 KiB）を超えた。本文は検証せずに拒否する。 */
  PAYLOAD_TOO_LARGE: "https://starter.local/problems/payload-too-large",
} as const satisfies Record<string, string>;

/** どの API からでも返り得るエラーコード。{@link platformProblemTypes} のキー。 */
export type PlatformProblemCode = keyof typeof platformProblemTypes;
