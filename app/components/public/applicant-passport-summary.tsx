'use client';

import type { FlowPassPassport } from '../../../shared/passport-contract';
import { applicantVisibleCopy } from './applicant-copy';

type PassportNode = FlowPassPassport['nodes'][number];

const audienceLabels = {
  self: '僅限本人',
  team: '團隊成員',
  client: '指定對象',
  public: '公開',
  unknown: '待確認',
} as const;

const nodeKindFallbacks: Record<PassportNode['kind'], string> = {
  data: '原始資料',
  ai_tool: 'AI 工具',
  plugin: '外掛工具',
  storage: '保存位置',
  person: '使用者',
  organization: '所屬組織',
  destination: '輸出位置',
};

/** Fixed reading order for applicants: what goes in, who processes it, where it rests, who sees it. */
const STAGES: Array<{ key: 'data' | 'tool' | 'storage' | 'share'; title: string; kinds: PassportNode['kind'][] }> = [
  { key: 'data', title: '用到的資料', kinds: ['data'] },
  { key: 'tool', title: '交給 AI 處理', kinds: ['ai_tool', 'plugin'] },
  { key: 'storage', title: '存放位置', kinds: ['storage'] },
  { key: 'share', title: '分享與發布', kinds: ['destination', 'organization', 'person'] },
];

type FlowChip = { id: string; label: string; pending: boolean };
type FlowStage = { key: string; title: string; items: FlowChip[]; sensitive: FlowChip[] };

function flowChip(node: PassportNode): FlowChip {
  return { id: node.id, label: applicantVisibleCopy(node.label, nodeKindFallbacks[node.kind]), pending: node.needs_confirmation };
}

function flowStages(passport: FlowPassPassport): FlowStage[] {
  return STAGES
    .map((stage) => {
      const nodes = passport.nodes.filter((node) => stage.kinds.includes(node.kind));
      const sensitive = stage.key === 'data' ? nodes.filter((node) => node.data_category === 'personal_data') : [];
      const items = nodes.filter((node) => !sensitive.includes(node));
      return { key: stage.key, title: stage.title, items: items.map(flowChip), sensitive: sensitive.map(flowChip) };
    })
    .filter((stage) => stage.key === 'share' || stage.items.length > 0 || stage.sensitive.length > 0);
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
  const draft = mode === 'draft';
  const stages = flowStages(passport);
  const title = applicantVisibleCopy(passport.use_case.title, 'AI 使用流程');
  const purpose = applicantVisibleCopy(passport.use_case.purpose, '請確認資料內容、AI 使用方式與分享對象是否相符。');
  const intendedOutcome = applicantVisibleCopy(passport.use_case.intended_outcome, '完成資料處理並確認分享方式');
  const chips = (items: FlowChip[], sensitive = false) => (
    <ul className="applicant-flow-chips">
      {items.map((item) => (
        <li key={item.id} className={sensitive ? 'applicant-flow-chip is-sensitive' : 'applicant-flow-chip'}>
          {item.label}
          {draft && item.pending && <em>待確認</em>}
        </li>
      ))}
    </ul>
  );

  return (
    <section className="applicant-passport-summary" aria-label={draft ? undefined : '已確認的資料流向'} aria-labelledby={draft ? 'applicant-passport-title' : undefined}>
      {draft && (
        <>
          <header>
            <p className="eyebrow">確認資料流向</p>
            <h2 id="applicant-passport-title">{title}</h2>
            <p>{purpose}</p>
          </header>
          <div className="applicant-passport-outcome">
            <span>預計完成</span>
            <strong>{intendedOutcome}</strong>
          </div>
        </>
      )}
      <section aria-labelledby="applicant-flow-title">
        <h3 id="applicant-flow-title" className={draft ? 'applicant-flow-title' : 'sr-only'}>資料怎麼流動</h3>
        <ol className="applicant-flow-stages">
          {stages.map((stage) => (
            <li className="applicant-flow-stage" key={stage.key}>
              <span className="applicant-flow-marker" aria-hidden="true" />
              <div className="applicant-flow-stage-body">
                <h4>{stage.title}</h4>
                {stage.items.length > 0 && chips(stage.items)}
                {stage.sensitive.length > 0 && (
                  <>
                    <p className="applicant-flow-note">其中包含敏感資料：</p>
                    {chips(stage.sensitive, true)}
                  </>
                )}
                {stage.key === 'share' && (
                  <p className="applicant-flow-note">看得到成果的人：<strong>{audienceLabels[passport.sharing_scope.audience]}</strong></p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
      {passport.safety_actions.length > 0 && (
        <section className="applicant-safety-list" aria-labelledby="applicant-safety-title">
          <h3 id="applicant-safety-title">{draft ? '送出前確認事項' : '使用時記得'}</h3>
          {passport.safety_actions.map((action) => (
            <article key={action.id}>
              <strong>{applicantVisibleCopy(action.action, '確認資料處理與分享方式')}</strong>
              <p>{applicantVisibleCopy(action.reason, '請確認資料內容、分享對象與使用方式符合實際情況。')}</p>
            </article>
          ))}
        </section>
      )}
      {draft && workflowState === 'follow_up_required' && (
        <p className="applicant-next-step">請先回答下方問題，確認後點擊「重新產生資料流向」。</p>
      )}
      {onContinue && (
        <div className="applicant-passport-controls">
          <button type="button" className="primary-action" disabled={busy} onClick={onContinue}>
            {busy ? '處理中…' : '確認無誤，前往附件'}
          </button>
        </div>
      )}
    </section>
  );
}
