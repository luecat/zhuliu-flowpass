export function AiWaitingStatus({ progressPercent }: { progressPercent: number }) {
  return (
    <div className="ai-waiting-status" role="status" aria-live="polite">
      <strong>思考中…</strong>
      <span>完成度 {Math.max(0, Math.min(100, Math.round(progressPercent)))}%</span>
    </div>
  );
}
