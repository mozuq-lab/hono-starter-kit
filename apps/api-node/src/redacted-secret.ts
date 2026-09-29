import { inspect } from "node:util";

const redacted = "[REDACTED]";

// 設定オブジェクトごとログに出したり JSON にしたりしても値が漏れないよう、秘密値を包む。
// 関数の背後に隠す形（createDatabasePassword と同じ）ではなくクラスにしたのは、
// AuthConfig の中で「どの認証方式か」を読める値のまま保ち、テストで検査できるようにするため。
// 値は private フィールドに置く。通常のプロパティにすると Object.entries、structuredClone、
// vitest の差分表示などから読めてしまう。
export class RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return redacted;
  }

  toJSON(): string {
    return redacted;
  }

  [inspect.custom](): string {
    return redacted;
  }
}
