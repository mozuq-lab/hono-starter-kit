export function ProjectsErrorView({
  requestId,
  onRetry,
}: {
  requestId?: string | undefined;
  onRetry: () => void;
}) {
  return (
    <main>
      <h1>Projects</h1>
      <div role="alert">
        <p>Projects を読み込めませんでした。</p>
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
