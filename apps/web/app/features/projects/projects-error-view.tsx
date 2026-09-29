import {
  alertBoxClass,
  alertCodeClass,
  alertDetailClass,
  alertMessageClass,
  pageMainClass,
  pageTitleClass,
  primaryButtonClass,
} from "../../components/ui-classes.js";

export function ProjectsErrorView({
  requestId,
  onRetry,
}: {
  requestId?: string | undefined;
  onRetry: () => void;
}) {
  return (
    <main className={`${pageMainClass} text-center`}>
      <h1 className={pageTitleClass}>Projects</h1>
      <div className={`${alertBoxClass} text-left`} role="alert">
        <p className={alertMessageClass}>Projects を読み込めませんでした。</p>
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
