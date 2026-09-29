import {
  alertBoxClass,
  alertCodeClass,
  alertDetailClass,
  alertMessageClass,
  pageMainClass,
  pageTitleClass,
  primaryButtonClass,
} from "./ui-classes.js";

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
    <main className={`${pageMainClass} text-center`}>
      <h1 className={pageTitleClass}>読み込めませんでした</h1>
      <div className={`${alertBoxClass} text-left`} role="alert">
        <p className={alertMessageClass}>画面を読み込めませんでした。</p>
        {requestId ? (
          <p className={alertDetailClass}>
            Request ID: <code className={alertCodeClass}>{requestId}</code>
          </p>
        ) : null}
      </div>
      <button
        className={`${primaryButtonClass} mt-4`}
        type="button"
        onClick={onRetry}
      >
        再試行
      </button>
    </main>
  );
}
