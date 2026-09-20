import { useCallback, useEffect, useState } from 'react';
import type { AdminRequest } from './api';
import type { AiUsage } from './types';

export function AiUsagePanel({ request, onBack }: { request: AdminRequest; onBack: () => void }) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { setUsage(await request<AiUsage>('/admin/v1/ai-usage')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'AI 用量無法載入。'); } finally { setLoading(false); } }, [request]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern; setState only runs after the awaited request settles.
  useEffect(() => { void load(); }, [load]);
  return <section className="work ai-usage"><header className="work-head"><div><button className="data-back" onClick={onBack}>← 返回案件總覽</button><p className="eyebrow">AI 使用監控</p><h1>AI 用量</h1><p>追蹤每個模型的實際請求數、輸入 tokens 與 AI 執行次數。</p></div><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? '更新中…' : '重新整理'}</button></header>{error && <div className="alert" role="alert">{error}</div>}{loading && !usage ? <div className="loading" role="status">正在載入 AI 用量…</div> : usage && <><div className="ai-usage-meta"><span>供應商：{usage.provider}</span><span>目前分鐘：{usage.minuteKey}</span><span>台北日：{usage.dayKey}</span></div>{usage.models.length === 0 ? <p className="ai-usage-empty">今天還沒有任何模型請求。</p> : <div className="ai-usage-grid">{usage.models.map((model) => <article className="ai-usage-card" key={model.id}><h2>{model.id}</h2><p>已記錄 AI 執行：<strong>{model.recordedRuns}</strong> 次（平均 {(model.averageDurationMs / 1000).toFixed(1)} 秒）</p><dl><div><dt>本分鐘請求</dt><dd>{model.requestsThisMinute}<small>{model.inputTokensThisMinute.toLocaleString()} tokens</small></dd></div><div><dt>今日請求</dt><dd>{model.requestsToday}<small>{model.inputTokensToday.toLocaleString()} tokens</small></dd></div></dl></article>)}</div>}</>}</section>;
}
