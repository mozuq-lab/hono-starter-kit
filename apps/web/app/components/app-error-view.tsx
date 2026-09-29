/**
 * アプリの外枠のエラー表示。レイアウトの loader（/api/me など）の失敗は機能に依らないので、
 * 機能名を出さず、Request ID と再試行だけを持つ。機能固有の文言は各機能のルートで持つ。
 */
export function AppErrorView({
  requestId,
  onRetry,
}: {
  requestId?: string | undefined;
  onRetry: () => void;
}) {
  return (
    <main>
      <h1>読み込めませんでした</h1>
      <div role="alert">
        <p>画面を読み込めませんでした。</p>
        {requestId ? (
          <p>
            Request ID: <code>{requestId}</code>
          </p>
        ) : null}
      </div>
      <button type="button" onClick={onRetry}>
        再試行
      </button>
    </main>
  );
}
