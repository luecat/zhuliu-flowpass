export type AiWaitingPhase = 'submitted' | 'queued' | 'working' | 'completed';

const PHASE_COPY: Record<AiWaitingPhase, { title: string; detail: string }> = {
  submitted: { title: '已送出', detail: '系統已收到資料，正在安排處理。' },
  queued: { title: '排隊中', detail: '目前處理人數較多，請稍候。' },
  working: { title: '整理中', detail: '正在產生資料流向草稿。' },
  completed: { title: '整理完成', detail: '資料流向草稿已產生。' },
};

export function AiWaitingStatus({
  phase,
  elapsedSeconds = 0,
  saved = true,
}: {
  phase: AiWaitingPhase;
  /** Kept for compatibility with older call sites that still pass a fake percent. */
  progressPercent?: number;
  elapsedSeconds?: number;
  saved?: boolean;
  announce?: boolean;
}) {
  const copy = PHASE_COPY[phase];
  const longWait = elapsedSeconds >= 60;
  return (
    <div className="ai-waiting-status" role="status" aria-live="off">
      <span className="ai-waiting-spinner" aria-hidden="true" />
      <strong aria-hidden="true">{copy.title}</strong>
      <span aria-hidden="true">{copy.detail}</span>
      {saved && <span aria-hidden="true">資料已自動保存。稍後可透過 LINE 選單繼續申請。</span>}
      {longWait && phase !== 'completed' && (
        <span aria-hidden="true">處理中，請勿重新送出。若數分鐘後仍無結果，請稍後再試。</span>
      )}
      <span className="sr-only" aria-live="polite">{`目前狀態：${copy.title}${longWait && phase !== 'completed' ? '，仍在處理中' : ''}`}</span>
    </div>
  );
}
