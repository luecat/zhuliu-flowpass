'use client';

import { Fragment, useState } from 'react';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { applicantVisibleCopy } from './applicant-copy';

const audienceLabels = {
  self: '僅自己',
  team: '團隊成員',
  client: '指定對象',
  public: '公開',
  unknown: '待確認',
} as const;

const nodeKindFallbacks: Record<FlowPassPassport['nodes'][number]['kind'], string> = {
  data: '資料',
  ai_tool: 'AI 工具',
  plugin: '外掛工具',
  storage: '保存位置',
  person: '使用者',
  organization: '所屬組織',
  destination: '輸出位置',
};

function flowNodesInOrder(passport: FlowPassPassport): FlowPassPassport['nodes'] {
  const nodeById = new Map(passport.nodes.map((node) => [node.id, node]));
  const incoming = new Map(passport.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(passport.nodes.map((node) => [node.id, [] as string[]]));
  passport.edges.forEach((edge) => {
    if (!nodeById.has(edge.from_node_id) || !nodeById.has(edge.to_node_id)) return;
    outgoing.get(edge.from_node_id)!.push(edge.to_node_id);
    incoming.set(edge.to_node_id, (incoming.get(edge.to_node_id) ?? 0) + 1);
  });
  const queue = passport.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const seen = new Set<string>();
  const ordered: FlowPassPassport['nodes'] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    ordered.push(nodeById.get(nodeId)!);
    outgoing.get(nodeId)?.forEach((nextId) => {
      const nextIncoming = (incoming.get(nextId) ?? 1) - 1;
      incoming.set(nextId, nextIncoming);
      if (nextIncoming === 0) queue.push(nextId);
    });
  }
  passport.nodes.forEach((node) => {
    if (!seen.has(node.id)) ordered.push(node);
  });
  return ordered;
}

export function ApplicantPassportSummary({
  passport,
  workflowState,
  onContinue,
  busy = false,
  mode = 'draft',
}: {
  passport: FlowPassPassport;
  workflowState: string;
  onContinue?: () => void;
  busy?: boolean;
  mode?: 'draft' | 'record';
}) {
  const [confirmed, setConfirmed] = useState(false);
  const orderedFlowNodes = flowNodesInOrder(passport);
  const title = applicantVisibleCopy(passport.use_case.title, 'AI 使用流程');
  const purpose = applicantVisibleCopy(passport.use_case.purpose, '請確認資料內容、AI 使用方式與分享對象是否符合實際情況。');
  const intendedOutcome = applicantVisibleCopy(passport.use_case.intended_outcome, '完成資料處理並確認分享方式');
  return (
    <section className="applicant-passport-summary" aria-labelledby="applicant-passport-title">
      <header>
        <p className="eyebrow">{mode === 'record' ? '已確認的資料流向' : '確認資料流向'}</p>
        <h2 id="applicant-passport-title">{title}</h2>
        <p>{purpose}</p>
      </header>
      <div className="applicant-passport-outcome">
        <span>預計完成</span>
        <strong>{intendedOutcome}</strong>
      </div>
      <section aria-labelledby="applicant-flow-title">
        <div className="applicant-passport-heading">
          <h3 id="applicant-flow-title">資料怎麼流動</h3>
          <span>分享對象：{audienceLabels[passport.sharing_scope.audience]}</span>
        </div>
        <div className="applicant-flow-list">
          {orderedFlowNodes.map((node, index) => (
            <Fragment key={node.id}>
              <article>
                <strong>{applicantVisibleCopy(node.label, nodeKindFallbacks[node.kind])}</strong>
              </article>
              {index < orderedFlowNodes.length - 1 && <span className="applicant-flow-arrow" aria-hidden="true">↓</span>}
            </Fragment>
          ))}
        </div>
      </section>
      {passport.safety_actions.length > 0 && (
        <section className="applicant-safety-list" aria-labelledby="applicant-safety-title">
          <h3 id="applicant-safety-title">{mode === 'record' ? '資料使用注意事項' : '送出前請確認'}</h3>
          {passport.safety_actions.map((action) => (
            <article key={action.id}>
              <strong>{applicantVisibleCopy(action.action, '確認資料處理與分享方式')}</strong>
              <p>{applicantVisibleCopy(action.reason, '請確認資料內容、分享對象與使用方式符合你的實際情況。')}</p>
            </article>
          ))}
        </section>
      )}
      {mode === 'draft' && workflowState === 'follow_up_required' && <p className="applicant-next-step">請先回答下方問題，系統會再整理一次護照。</p>}
      {onContinue && (
        <div className="applicant-passport-controls">
          <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已確認以上內容</label>
          <button type="button" className="primary-action" disabled={!confirmed || busy} onClick={onContinue}>
            {busy ? '正在確認…' : '確認內容，前往附件'}
          </button>
        </div>
      )}
    </section>
  );
}
