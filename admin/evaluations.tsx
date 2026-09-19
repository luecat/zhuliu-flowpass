import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { record, evaluationOf } from './parsers';
import type { RuleEvaluationView } from './types';
import { ruleLabel, outcomeLabel } from './format';

export function Evaluations({ caseId }: { caseId: string }) {
  const [items, setItems] = useState<RuleEvaluationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<unknown>(`/admin/v1/cases/${encodeURIComponent(caseId)}/evaluations`).then((value) => {
      if (!active) return;
      const data = record(value);
      setItems((Array.isArray(data.evaluations) ? data.evaluations : []).map(evaluationOf).filter((item): item is RuleEvaluationView => item !== null));
    }).catch(() => { if (active) setError('勾稽結果暫時無法載入。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId]);
  const ordered = useMemo(() => items.slice().sort((left, right) => {
    const rank = (outcome: string) => outcome === 'needs_review' ? 0 : outcome === 'fail' ? 1 : outcome === 'missing' ? 2 : 3;
    return rank(left.outcome) - rank(right.outcome);
  }), [items]);
  return <section className="evaluations" aria-labelledby="evaluations-title"><div className="attachments-head"><h3 id="evaluations-title">勾稽結果（{ordered.length}）</h3>{loading && <span role="status">載入中…</span>}</div>{error ? <p className="error" role="alert">{error}</p> : !loading && ordered.length === 0 ? <p className="attachments-empty">尚無規則判定紀錄。</p> : <ul className="evaluation-list">{ordered.map((item) => <li key={item.id} className={`evaluation-item outcome-${item.outcome}`}><div className="evaluation-head"><strong>{ruleLabel(item.ruleCode)}</strong><span className={`status state-${item.outcome === 'needs_review' ? 'needs-review' : item.outcome}`}>{outcomeLabel(item.outcome)}</span></div>{item.explanation && <p>{item.explanation}</p>}{item.steps.length > 0 && <dl className="evaluation-steps">{item.steps.map((step) => <div key={`${item.id}-${step.label}`}><dt>{step.label}</dt><dd>{step.value}</dd></div>)}</dl>}</li>)}</ul>}</section>;
}
