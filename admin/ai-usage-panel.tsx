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
  return <section className="work ai-usage"><header className="work-head"><div><button className="data-back" onClick={onBack}>← 返回案件總覽</button><p className="eyebrow">AI 使用監控</p><h1>AI 用量</h1><p>獨立追蹤模型的 RPM、TPM、RPD 與 AI 執行次數。</p></div><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? '更新中…' : '重新整理'}</button></header>{error && <div className="alert" role="alert">{error}</div>}{loading && !usage ? <div className="loading" role="status">正在載入 AI 用量…</div> : usage && <><div className="ai-usage-meta"><span>供應商：{usage.provider}</span><span>目前分鐘：{usage.minuteKey}</span><span>Pacific 日：{usage.dayKey}</span></div><div className="ai-usage-grid">{usage.models.map((model) => <article className="ai-usage-card" key={model.id}><h2>{model.id}</h2><p>已記錄 AI 執行：<strong>{model.recordedRuns}</strong> 次</p><dl><div><dt>RPM</dt><dd>{model.rpm.used} / {model.rpm.limit}<small>剩餘 {model.rpm.remaining}</small></dd></div><div><dt>TPM</dt><dd>{model.tpm.used.toLocaleString()} / {model.tpm.limit.toLocaleString()}<small>剩餘 {model.tpm.remaining.toLocaleString()} tokens</small></dd></div><div><dt>RPD</dt><dd>{model.rpd.used} / {model.rpd.limit}<small>剩餘 {model.rpd.remaining}</small></dd></div></dl></article>)}</div></>}</section>;
}
