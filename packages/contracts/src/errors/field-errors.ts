/**
 * 入力検証の issue を `fieldErrors`（フィールド名から messages への対応）へ畳む。
 *
 * `path[0]` が文字列の issue だけを採り、最上位のフィールド名をキーにする。
 * ネストした入力でも内部の構造は外へ出ない。この規則を変えると `fieldErrors` の
 * キーが変わり、画面のエラー表示先が変わる。
 *
 * @param issues 検証ライブラリの issue。`path` と `message` だけを読む。
 * @returns 同じフィールドの message を issue の順に積んだ対応。
 */
export const toFieldErrors = (
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): Record<string, string[]> =>
  issues.reduce<Record<string, string[]>>((errors, issue) => {
    const field = issue.path[0];
    if (typeof field === "string") {
      errors[field] = [...(errors[field] ?? []), issue.message];
    }
    return errors;
  }, {});
