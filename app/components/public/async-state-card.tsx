'use client';

export type AsyncLoadState = 'loading' | 'ready' | 'error';

export function AsyncStateCard({
  state,
  loadingLabel,
  errorTitle = '暫時無法載入',
  errorDetail = '請確認網路連線後再試一次。',
  emptyTitle,
  emptyDetail,
  emptyAction,
  onRetry,
  children,
}: {
  state: AsyncLoadState;
  loadingLabel: string;
  errorTitle?: string;
  errorDetail?: string;
  emptyTitle?: string;
  emptyDetail?: string;
  emptyAction?: React.ReactNode;
  onRetry?: () => void;
  children?: React.ReactNode;
}) {
  if (state === 'loading') {
    return (
      <div className="applicant-state-card" role="status">
        <span className="applicant-loading-mark" aria-hidden="true" />
        <p>{loadingLabel}</p>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="applicant-state-card applicant-state-card--error" role="alert">
        <h2>{errorTitle}</h2>
        <p>{errorDetail}</p>
        {onRetry && <button type="button" className="secondary-action" onClick={onRetry}>重新載入</button>}
      </div>
    );
  }
  if (emptyTitle) {
    return (
      <div className="applicant-state-card">
        <h2>{emptyTitle}</h2>
        {emptyDetail && <p>{emptyDetail}</p>}
        {emptyAction}
      </div>
    );
  }
  return <>{children}</>;
}
