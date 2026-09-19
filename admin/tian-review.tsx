import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { record, evaluationOf, attachmentOf, string, number } from './parsers';
import type { Attachment, Case, Review, ReviewDecision, RuleEvaluationView } from './types';
import { REVIEWS } from './types';
import { bytes, label, money, outcomeLabel, ruleLabel } from './format';

type PurchaseDetails = {
  softwareName?: string;
  companyName?: string;
  purchaseDate?: string;
  originalCurrency?: string;
  otherCurrency?: string | null;
  originalExpense?: string;
  convertedTwd?: number;
  invoiceNumber?: string | null;
  receiptBuyerName?: string | null;
  applicantName?: string | null;
};

type Selection =
  | { kind: 'none' }
  | { kind: 'eval'; id: string }
  | { kind: 'doc'; id: string };

type Verdict = 'good' | 'bad' | null;

const SIMILARITY_RULES = new Set([
  'invoice_fingerprint',
  'transaction_fingerprint',
  'payment_source_fingerprint',
  'invoice_duplicate',
]);

function purchaseDetailsOf(value: unknown): PurchaseDetails | null {
  if (value === null) return null;
  const v = record(value);
  return {
    softwareName: string(v.softwareName),
    companyName: string(v.companyName),
    purchaseDate: string(v.purchaseDate),
    originalCurrency: string(v.originalCurrency),
    otherCurrency: string(v.otherCurrency) ?? null,
    originalExpense: string(v.originalExpense),
    convertedTwd: number(v.convertedTwd),
    invoiceNumber: string(v.invoiceNumber) ?? null,
    receiptBuyerName: string(v.receiptBuyerName) ?? null,
    applicantName: string(v.applicantName) ?? null,
  };
}

function documentUrl(id: string) {
  return `/admin/v1/documents/${encodeURIComponent(id)}/content`;
}

function matchedCaseCodes(item: RuleEvaluationView): string[] {
  const blob = [item.explanation, ...item.steps.map((step) => step.value)].join(' ');
  return [...new Set([...blob.matchAll(/FP-\d{8}-[A-Z0-9]+/g)].map((match) => match[0]))];
}

function isSimilarity(item: RuleEvaluationView) {
  return SIMILARITY_RULES.has(item.ruleCode) && item.outcome === 'needs_review';
}

function DocPreview({ doc }: { doc: Attachment }) {
  if (doc.status !== 'ready') {
    return <p className="tian-idle">此附件尚無法預覽（{doc.status}）。</p>;
  }
  if (doc.mediaType === 'application/pdf') {
    return <iframe className="tian-frame" src={documentUrl(doc.id)} title={doc.originalName} />;
  }
  // Admin is Vite SPA, not Next.js.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="tian-img" src={documentUrl(doc.id)} alt={doc.originalName} />;
}

export function TianReview({
  item,
  busy,
  close,
  update,
}: {
  item: Case;
  busy: boolean;
  close: () => void;
  update: (review: Review, decision: ReviewDecision) => Promise<void>;
}) {
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [evaluations, setEvaluations] = useState<RuleEvaluationView[]>([]);
  const [documents, setDocuments] = useState<Attachment[]>([]);
  const [details, setDetails] = useState<PurchaseDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [reason, setReason] = useState('');
  const [supplementBusy, setSupplementBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(item.id)}/evaluations`),
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(item.id)}/documents`),
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(item.id)}/purchase-details`),
    ])
      .then(([evalValue, docsValue, purchaseValue]) => {
        if (!active) return;
        const evalData = record(evalValue);
        const docsData = record(docsValue);
        setEvaluations(
          (Array.isArray(evalData.evaluations) ? evalData.evaluations : [])
            .map(evaluationOf)
            .filter((value): value is RuleEvaluationView => value !== null),
        );
        setDocuments(
          (Array.isArray(docsData.documents) ? docsData.documents : [])
            .map(attachmentOf)
            .filter((value): value is Attachment => value !== null),
        );
        setDetails(purchaseDetailsOf(record(purchaseValue).purchaseDetails ?? null));
      })
      .catch(() => {
        if (active) setError('核對資料暫時無法載入。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [item.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const orderedEvals = useMemo(
    () =>
      evaluations.slice().sort((left, right) => {
        const rank = (outcome: string) =>
          outcome === 'needs_review' ? 0 : outcome === 'fail' ? 1 : outcome === 'missing' ? 2 : 3;
        return rank(left.outcome) - rank(right.outcome);
      }),
    [evaluations],
  );

  const invoices = documents.filter((doc) => doc.kind === 'invoice' && doc.status === 'ready');
  const selectedEval =
    selection.kind === 'eval' ? orderedEvals.find((value) => value.id === selection.id) ?? null : null;
  const selectedDoc =
    selection.kind === 'doc' ? documents.find((value) => value.id === selection.id) ?? null : null;
  const similarity = selectedEval ? isSimilarity(selectedEval) : false;
  const matchCodes = selectedEval && similarity ? matchedCaseCodes(selectedEval) : [];
  const verdictKey =
    selection.kind === 'eval'
      ? `eval:${selection.id}`
      : selection.kind === 'doc'
        ? `doc:${selection.id}`
        : '';
  const verdict = verdictKey ? (verdicts[verdictKey] ?? null) : null;
  const canRequestDocuments =
    item.state === 'under_review' &&
    REVIEWS.some((review) => review.action === 'request_documents' && review.fromStates.includes(item.state));

  const setVerdict = (next: Verdict) => {
    if (!verdictKey) return;
    setVerdicts((prev) => ({ ...prev, [verdictKey]: next }));
    if (next !== 'bad') setReason('');
  };

  const submitSupplement = async () => {
    const review = REVIEWS.find((value) => value.action === 'request_documents');
    if (!review || !reason.trim() || !canRequestDocuments) return;
    setSupplementBusy(true);
    try {
      await update(review, {
        title: selectedDoc?.originalName ?? '附件不符',
        instructions: reason.trim(),
        reason: reason.trim(),
      });
      close();
    } finally {
      setSupplementBusy(false);
    }
  };

  let topLeft: ReturnType<typeof DocPreview> | null = null;
  let topRight: ReturnType<typeof DocPreview> | null = null;

  if (selection.kind === 'none') {
    topLeft = <p className="tian-idle">點選左下勾稽結果或右下附件，這裡會顯示對應影像。</p>;
    topRight = (
      <div className="tian-basic">
        <div className="tian-cell-head"><h2>案件基本資料</h2></div>
        <div className="tian-basic-body">
          <span className="tian-badge">{item.caseCode}</span>
          <span className={`status state-${item.state}`}>{label(item.state)}</span>
          <p>點選下方清單開始核對。粗版：相似度比對尚無法載入他案影像，只顯示案號。</p>
        </div>
      </div>
    );
  } else if (selectedEval && similarity) {
    topLeft = (
      <div className="tian-pane">
        <div className="tian-cell-head">
          <h2>比對案件</h2>
          <span>{matchCodes[0] ?? '（尚未解析到案號）'}</span>
        </div>
        <div className="tian-stage tian-stage-note">
          {matchCodes.length > 0 ? (
            <div>
              <p>指紋相同案件：</p>
              <ul>{matchCodes.map((code) => <li key={code}>{code}</li>)}</ul>
              <p className="tian-muted">粗版尚未載入他案附件影像。</p>
            </div>
          ) : (
            <p>{selectedEval.explanation || '有重複訊號，但步驟文字裡沒有案號。'}</p>
          )}
        </div>
      </div>
    );
    topRight = (
      <div className="tian-pane">
        <div className="tian-cell-head"><h2>本案件</h2><span>{item.caseCode}</span></div>
        <div className="tian-stage">
          {invoices[0] ? <DocPreview doc={invoices[0]} /> : <p className="tian-idle">本案尚無可用發票影像。</p>}
        </div>
        <div className="tian-verdict">
          <p className="tian-muted">{selectedEval.explanation}</p>
          <div className="tian-verdict-row">
            <button type="button" className={verdict === 'good' ? 'is-on' : ''} onClick={() => setVerdict('good')}>無疑慮</button>
            <button type="button" className={verdict === 'bad' ? 'is-on is-bad' : ''} onClick={() => setVerdict('bad')}>有疑慮</button>
          </div>
        </div>
      </div>
    );
  } else if (selectedEval) {
    topLeft = <p className="tian-idle">此勾稽不是相似度比對，無需左右對圖。</p>;
    topRight = (
      <div className="tian-pane">
        <div className="tian-cell-head"><h2>{ruleLabel(selectedEval.ruleCode)}</h2><span>{outcomeLabel(selectedEval.outcome)}</span></div>
        <div className="tian-basic-body">
          <p>{selectedEval.explanation || '（無說明）'}</p>
          {selectedEval.steps.length > 0 && (
            <dl className="tian-fields">
              {selectedEval.steps.map((step) => (
                <div key={`${selectedEval.id}-${step.label}`}><dt>{step.label}</dt><dd>{step.value}</dd></div>
              ))}
            </dl>
          )}
        </div>
      </div>
    );
  } else if (selectedDoc) {
    topLeft = (
      <div className="tian-pane">
        <div className="tian-cell-head"><h2>附件原圖</h2><span>{selectedDoc.originalName} · {bytes(selectedDoc.byteSize)}</span></div>
        <div className="tian-stage"><DocPreview doc={selectedDoc} /></div>
      </div>
    );
    topRight = (
      <div className="tian-pane">
        <div className="tian-cell-head"><h2>申請人填寫內容</h2></div>
        <dl className="tian-fields">
          <div><dt>申請人</dt><dd>{details?.applicantName ?? item.applicantName ?? '—'}</dd></div>
          <div className="is-key"><dt>發票號碼</dt><dd>{details?.invoiceNumber ?? '未填寫'}</dd></div>
          <div className="is-key"><dt>換算新台幣</dt><dd>{money(details?.convertedTwd ?? item.requestedAmountTwd)}</dd></div>
          <div><dt>軟體名稱</dt><dd>{details?.softwareName ?? '—'}</dd></div>
          <div><dt>供應商</dt><dd>{details?.companyName ?? '—'}</dd></div>
          <div><dt>購買日期</dt><dd>{details?.purchaseDate ?? '—'}</dd></div>
          <div><dt>收據買受人</dt><dd>{details?.receiptBuyerName ?? '—'}</dd></div>
        </dl>
        <div className="tian-verdict">
          <div className="tian-verdict-row">
            <button type="button" className={verdict === 'good' ? 'is-on' : ''} onClick={() => setVerdict('good')}>相符</button>
            <button type="button" className={verdict === 'bad' ? 'is-on is-bad' : ''} onClick={() => setVerdict('bad')}>不相符</button>
          </div>
          {verdict === 'bad' && (
            <div className="tian-followup">
              <label htmlFor="tian-reason">不相符原因（會顯示給申請人）</label>
              <textarea id="tian-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：發票金額與填寫金額不符" />
              {canRequestDocuments ? (
                <button type="button" className="tian-supplement" disabled={supplementBusy || busy || !reason.trim()} onClick={() => void submitSupplement()}>
                  {supplementBusy || busy ? '送出中…' : '送出並要求補件'}
                </button>
              ) : (
                <p className="tian-muted">案件不在「審核中」時，無法從此處直接要求補件。</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tian-screen" role="dialog" aria-modal="true" aria-label={`田字格核對 ${item.caseCode}`}>
      <header className="tian-topbar">
        <button type="button" className="tian-back" onClick={close}>← 返回案件詳情</button>
        <span className="tian-topbar-code">{item.caseCode}</span>
        <button type="button" className="tian-exit" onClick={close} aria-label="關閉田字格核對">×</button>
      </header>
      {error && <p className="error tian-error" role="alert">{error}</p>}
      {loading ? (
        <div className="tian-loading" role="status">載入核對資料…</div>
      ) : (
        <div className="tian">
          <div className="tian-cell tian-tl">{topLeft}</div>
          <div className="tian-cell tian-tr">{topRight}</div>
          <div className="tian-cell tian-bl">
            <div className="tian-cell-head"><h2>勾稽結果</h2><span>{orderedEvals.length} 項</span></div>
            <div className="tian-rail">
              {orderedEvals.length === 0 ? <p className="tian-muted">尚無勾稽結果。</p> : orderedEvals.map((evalItem) => {
                const active = selection.kind === 'eval' && selection.id === evalItem.id;
                const flagged = evalItem.outcome === 'needs_review' || evalItem.outcome === 'fail';
                return (
                  <button
                    key={evalItem.id}
                    type="button"
                    className={`tian-eval${flagged ? ' is-flag' : ''}${active ? ' is-active' : ''}`}
                    onClick={() => setSelection({ kind: 'eval', id: evalItem.id })}
                  >
                    <div className="tian-eval-head">
                      <strong>{ruleLabel(evalItem.ruleCode)}</strong>
                      <span className={`status state-${evalItem.outcome === 'needs_review' ? 'needs-review' : evalItem.outcome}`}>
                        {outcomeLabel(evalItem.outcome)}
                        {isSimilarity(evalItem) ? '・點擊比對' : ''}
                      </span>
                    </div>
                    {evalItem.explanation && <p>{evalItem.explanation}</p>}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="tian-cell tian-br">
            <div className="tian-cell-head"><h2>附件</h2><span>{documents.length} 項</span></div>
            <div className="tian-rail">
              {documents.length === 0 ? <p className="tian-muted">尚無附件。</p> : documents.map((doc) => {
                const active = selection.kind === 'doc' && selection.id === doc.id;
                const mark = verdicts[`doc:${doc.id}`];
                return (
                  <button
                    key={doc.id}
                    type="button"
                    className={`tian-doc${active ? ' is-active' : ''}`}
                    onClick={() => setSelection({ kind: 'doc', id: doc.id })}
                  >
                    <span>
                      <strong>{doc.originalName}</strong>
                      <small>{doc.kind} · {bytes(doc.byteSize)}</small>
                    </span>
                    <em>{mark === 'good' ? '相符' : mark === 'bad' ? '不相符' : '點擊核對'}</em>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
