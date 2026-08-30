import { useState } from 'react';
import type {
  ConfirmationQuestion,
  FlowPassParseResult,
  IssueSeverity,
  QuestionPriority,
} from './passport-parser';

const priorityLabels: Record<QuestionPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const severityLabels: Record<IssueSeverity, string> = {
  error: '錯誤',
  warning: '警告',
  info: '提醒',
};

const evidenceLabels = {
  applicant_confirmation: '本人確認',
  system_check: '系統檢查',
  officer_review: '承辦複核',
} as const;

const audienceLabels = {
  self: '本人',
  team: '團隊',
  client: '客戶',
  public: '公開',
  unknown: '未知',
} as const;

function InvalidResult({ result }: { result: FlowPassParseResult }) {
  return (
    <section className="passport-invalid" role="alert">
      <span className="result-kicker">無法建立護照視圖</span>
      <h2>請先修正 JSON</h2>
      <ul>
        {result.issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.path}-${index}`}>
            <code>{issue.path}</code>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FlowSection({ result }: { result: FlowPassParseResult }) {
  if (!result.passport || !result.summary) return <InvalidResult result={result} />;

  const graphIssues = result.issues.filter(
    (issue) => issue.category === 'graph',
  );

  return (
    <div className="passport-flow-view" aria-live="polite">
      <section className="use-case-card">
        <span className="result-kicker">USE CASE</span>
        <h2>{result.passport.use_case.title}</h2>
        <p>{result.passport.use_case.purpose}</p>
        <div>
          <span>預期成果</span>
          <strong>{result.passport.use_case.intended_outcome}</strong>
        </div>
      </section>

      <section className="parsed-section" aria-labelledby="flow-heading">
        <div className="section-heading">
          <div>
            <span>DATA FLOW</span>
            <h3 id="flow-heading">資料去了哪裡</h3>
          </div>
          <b>{result.summary.edgeCount} 條連線</b>
        </div>
        <div className="readable-flow-list">
          {result.summary.flows.map((flow) => (
            <article
              className="readable-flow-card"
              data-testid="readable-flow"
              key={flow.id}
            >
              <span className="sr-only">
                {flow.fromLabel} 傳送到 {flow.toLabel}：{flow.purpose}
              </span>
              <div className="flow-route" aria-hidden="true">
                <span>{flow.fromLabel}</span>
                <i>→</i>
                <span>{flow.toLabel}</span>
              </div>
              <p aria-hidden="true">{flow.purpose}</p>
              {flow.needsConfirmation && <small>待本人確認</small>}
            </article>
          ))}
        </div>
      </section>

      {graphIssues.length > 0 && (
        <section className="parsed-section" aria-labelledby="graph-heading">
          <div className="section-heading">
            <div>
              <span>GRAPH CHECK</span>
              <h3 id="graph-heading">節點連線檢查</h3>
            </div>
            <b>{graphIssues.length} 項</b>
          </div>
          <ul className="compact-issue-list">
            {graphIssues.map((issue, index) => (
              <li
                className={`issue-${issue.severity}`}
                key={`${issue.code}-${issue.path}-${index}`}
              >
                <strong>{severityLabels[issue.severity]}</strong>
                <span>{issue.message}</span>
                <code>{issue.path}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function sortedQuestions(
  questions: ConfirmationQuestion[],
): ConfirmationQuestion[] {
  const order: QuestionPriority[] = ['high', 'medium', 'low'];
  return order.flatMap((priority) =>
    questions.filter((question) => question.priority === priority),
  );
}

function DetailsSection({
  result,
  showQuestions,
  onConfirm,
  onSubmit,
  canSubmit = false,
  workflowState,
}: {
  result: FlowPassParseResult;
  showQuestions: boolean;
  onConfirm?: (confirmed: boolean) => void;
  onSubmit?: () => void;
  canSubmit?: boolean;
  workflowState?: string;
}) {
  if (!result.passport || !result.summary) return <InvalidResult result={result} />;

  const isGraphInvalid = result.status === 'invalid_graph';
  const isConfirmed = workflowState === 'confirmed';

  return (
    <div className="passport-details" aria-live="polite">
      <section className={isGraphInvalid ? 'draft-banner invalid' : 'draft-banner'}>
        <span aria-hidden="true">!</span>
        <div>
            <strong>{isConfirmed ? '護照已確認' : 'AI 草稿，尚未確認'}</strong>
            <p>
              {isGraphInvalid
                ? '節點引用仍有錯誤，修正前不可視為完整護照。'
                : isConfirmed
                  ? '這個版本已由你確認；送出申請後將鎖定本次資料。'
                : '解析成功不等於安全、合規或補助核准。'}
          </p>
        </div>
      </section>

      <section className="metric-grid" aria-label="護照數量摘要">
        <div>
          <strong>{result.summary.nodeCount}</strong>
          <span>個節點</span>
        </div>
        <div>
          <strong>{result.summary.edgeCount} 條連線</strong>
          <span>資料流</span>
        </div>
        <div>
          <strong>{result.summary.actionCount} 項措施</strong>
          <span>安全待辦</span>
        </div>
        <div>
          <strong>{result.summary.questionCount} 個問題</strong>
          <span>待確認</span>
        </div>
      </section>

      <section className="detail-block" aria-labelledby="issue-heading">
        <div className="detail-heading">
          <h3 id="issue-heading">解析檢查</h3>
          <span>{result.issues.length}</span>
        </div>
        <div
          className="issue-stack"
          role={isGraphInvalid ? 'alert' : undefined}
        >
          {result.issues.map((issue, index) => (
            <article
              className={`issue-card issue-${issue.severity}`}
              key={`${issue.code}-${issue.path}-${index}`}
            >
              <div>
                <strong>{severityLabels[issue.severity]}</strong>
                <code>{issue.path}</code>
              </div>
              <p>{issue.message}</p>
              {issue.relatedIds && issue.relatedIds.length > 0 && (
                <p className="issue-related-ids">
                  <span>相關 ID：</span>{' '}
                  {issue.relatedIds.map((id) => (
                    <code key={id}>{id}</code>
                  ))}
                </p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="detail-block" aria-labelledby="sensitivity-heading">
        <div className="detail-heading">
          <h3 id="sensitivity-heading">敏感程度</h3>
        </div>
        <div className="sensitivity-row">
          <span className="sensitivity-high">
            高 {result.summary.sensitivityCounts.high}
          </span>
          <span className="sensitivity-medium">
            中 {result.summary.sensitivityCounts.medium}
          </span>
          <span className="sensitivity-low">
            低 {result.summary.sensitivityCounts.low}
          </span>
          <span>未知 {result.summary.sensitivityCounts.unknown}</span>
        </div>
      </section>

      <section className="detail-block" aria-labelledby="action-heading">
        <div className="detail-heading">
          <h3 id="action-heading">安全措施</h3>
          <span>{result.passport.safety_actions.length}</span>
        </div>
        <div className="detail-card-list">
          {result.passport.safety_actions.map((action) => (
            <article data-testid="safety-action" key={action.id}>
              <div className="card-meta">
                <span>{evidenceLabels[action.evidence_type]}</span>
                <code>{action.id}</code>
              </div>
              <strong>{action.action}</strong>
              <p>{action.reason}</p>
            </article>
          ))}
        </div>
      </section>

      {showQuestions && (
        <section className="detail-block" aria-labelledby="question-heading">
          <div className="detail-heading">
            <h3 id="question-heading">待確認問題</h3>
            <div className="priority-summary" aria-label="問題優先度摘要">
              <span className="priority-high">
                高 {result.summary.priorityCounts.high}
              </span>
              <span className="priority-medium">
                中 {result.summary.priorityCounts.medium}
              </span>
              <span className="priority-low">
                低 {result.summary.priorityCounts.low}
              </span>
            </div>
          </div>
          <div className="detail-card-list question-list">
            {sortedQuestions(result.passport.confirmation_questions).map(
              (question) => (
                <article
                  className={`priority-${question.priority}`}
                  data-testid="confirmation-question"
                  key={question.id}
                >
                  <div className="card-meta">
                    <span>{priorityLabels[question.priority]}優先</span>
                    <code>{question.id}</code>
                  </div>
                  <strong>{question.question}</strong>
                  <p>{question.reason}</p>
                </article>
              ),
            )}
          </div>
        </section>
      )}

      <section className="detail-block" aria-labelledby="record-heading">
        <div className="detail-heading">
          <h3 id="record-heading">分享與保存</h3>
        </div>
        <dl className="passport-properties">
          <div>
            <dt>分享範圍</dt>
            <dd>{audienceLabels[result.passport.sharing_scope.audience]}</dd>
          </div>
          <div>
            <dt>保存位置</dt>
            <dd>{result.passport.retention.storage_location}</dd>
          </div>
          <div>
            <dt>保存期限</dt>
            <dd>{result.passport.retention.duration}</dd>
          </div>
          <div>
            <dt>刪除計畫</dt>
            <dd>{result.passport.retention.deletion_plan}</dd>
          </div>
          <div>
            <dt>指定工具</dt>
            <dd>{result.passport.administrative_hints.requested_tool}</dd>
          </div>
          <div>
            <dt>承辦複核</dt>
            <dd>
              {result.passport.administrative_hints.requires_officer_review
                ? '需要'
                : '不需要'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="detail-block" aria-labelledby="unknown-heading">
        <div className="detail-heading">
          <h3 id="unknown-heading">未知欄位</h3>
          <span>{result.summary.unknownFields.length}</span>
        </div>
        <ul className="unknown-field-list">
          {result.summary.unknownFields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </section>

      {(onConfirm || onSubmit) && <PassportConfirmationControls onConfirm={onConfirm} onSubmit={onSubmit} canSubmit={canSubmit} />}
    </div>
  );
}

function PassportConfirmationControls({
  onConfirm,
  onSubmit,
  canSubmit,
}: {
  onConfirm?: (confirmed: boolean) => void;
  onSubmit?: () => void;
  canSubmit: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <section className="passport-submit-card" aria-labelledby="passport-submit-heading">
      <h3 id="passport-submit-heading">送出前確認</h3>
      <label>
        <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); onConfirm?.(event.target.checked); }} />
        我已確認護照內容
      </label>
      {onSubmit && <button type="button" className="primary-action" disabled={!confirmed || !canSubmit} onClick={onSubmit}>送出申請</button>}
    </section>
  );
}

export function PassportViewer({
  result,
  section,
  showQuestions = true,
  onConfirm,
  onSubmit,
  canSubmit = false,
  workflowState,
}: {
  result: FlowPassParseResult;
  section: 'flow' | 'details';
  showQuestions?: boolean;
  onConfirm?: (confirmed: boolean) => void;
  onSubmit?: () => void;
  canSubmit?: boolean;
  workflowState?: string;
}) {
  return section === 'flow' ? (
    <FlowSection result={result} />
  ) : (
    <DetailsSection result={result} showQuestions={showQuestions} onConfirm={onConfirm} onSubmit={onSubmit} canSubmit={canSubmit} workflowState={workflowState} />
  );
}
