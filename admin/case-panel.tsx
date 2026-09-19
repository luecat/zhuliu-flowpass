import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Case, Review, ReviewDecision } from './types';
import { REVIEWS } from './types';
import { date, label, money } from './format';
import { Evaluations } from './evaluations';
import { Attachments } from './attachments';
import { PurchaseReview } from './purchase-review';

export function Panel({ item, busy, error, close, clearError, update }: { item: Case; busy: boolean; error: string; close: () => void; clearError: () => void; update: (review: Review, decision: ReviewDecision) => Promise<void> }) {
  const availableReviews = REVIEWS.filter((value) => value.fromStates.includes(item.state));
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(item.approvedAmountTwd?.toString() ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [reconfirm, setReconfirm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const review = availableReviews.find((value) => value.action === name);
  const amountLabel = review?.amount === 'disbursed' ? '匯款金額' : '核准金額';
  // Runs once per panel open, not on every `confirming` toggle — otherwise reopening or
  // closing the confirmation dialog would reschedule this and steal focus back from
  // whatever the confirmation flow just focused (its trigger button, or itself).
  useEffect(() => {
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirming) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, confirming]);
  useEffect(() => {
    if (!confirming) return;
    const dialog = confirmationDialog.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const timer = window.setTimeout(() => dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const amountIsValid = amount.trim().length > 0 && Number.isSafeInteger(Number(amount)) && Number(amount) >= 0;
  const missing: string[] = [];
  if (review?.supplement) {
    if (!title.trim()) missing.push(review.supplement === 'documents' ? '補件項目' : '需修正項目');
    if (!instructions.trim()) missing.push(review.supplement === 'documents' ? '給申請人的補件說明' : '給申請人的修正說明');
  } else if (review) {
    if (review.amount && !amountIsValid) missing.push(amountLabel);
    if (review.reasonLabel && !reason.trim()) missing.push(review.reasonLabel);
  }
  const decision: ReviewDecision = review?.supplement
    ? {
        reason: instructions.trim(),
        title: title.trim(),
        instructions: instructions.trim(),
        ...(review.supplement === 'correction' ? { passportReconfirmationRequired: reconfirm } : {}),
      }
    : {
        ...(review?.action === 'start_review'
          ? { reason: '開始審查' }
          : review?.reasonLabel && reason.trim()
            ? { reason: reason.trim() }
            : {}),
        ...(review?.amount === 'approved' && amountIsValid ? { approvedAmountTwd: Number(amount) } : {}),
        ...(review?.amount === 'disbursed' && amountIsValid ? { disbursedAmountTwd: Number(amount) } : {}),
      };
  const chooseReview = (next: string) => {
    setName(next);
    setReason('');
    const nextReview = REVIEWS.find((value) => value.action === next);
    setAmount((nextReview?.amount === 'disbursed' ? item.disbursedAmountTwd ?? item.approvedAmountTwd : item.approvedAmountTwd)?.toString() ?? '');
    setTitle('');
    setInstructions('');
    setReconfirm(false);
    setConfirming(false);
    clearError();
  };
  const closeConfirmation = () => {
    const dialog = confirmationDialog.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    setConfirming(false);
    window.setTimeout(() => confirmationTrigger.current?.focus(), 0);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!review || missing.length > 0 || busy) return;
    if (review.confirm) setConfirming(true);
    else void update(review, decision);
  };
  return <aside ref={panelRef} className="panel" role="dialog" aria-modal="true" aria-labelledby="case-title">
    <header><div><p className="eyebrow">案件詳情</p><h2 id="case-title">{item.caseCode}</h2></div><button ref={closeButtonRef} className="close" onClick={close} aria-label="關閉案件詳情">×</button></header>
    <dl><div><dt>狀態</dt><dd><span className={`status state-${item.state}`}>{label(item.state)}</span></dd></div><div><dt>申請人</dt><dd>{item.applicantName ?? '尚未提供'}</dd></div><div><dt>方案</dt><dd>{item.programName ?? '尚未提供'}</dd></div><div><dt>送出時間</dt><dd>{date(item.submittedAt)}</dd></div><div><dt>申請金額</dt><dd>{money(item.requestedAmountTwd)}</dd></div><div><dt>系統計算</dt><dd>{money(item.calculatedAmountTwd)}</dd></div><div><dt>核准金額</dt><dd>{money(item.approvedAmountTwd)}</dd></div><div><dt>最後更新</dt><dd>{date(item.updatedAt)}</dd></div></dl>
    <PurchaseReview key={`purchase-${item.id}`} caseId={item.id} />
    <Evaluations key={`eval-${item.id}`} caseId={item.id} />
    <Attachments key={item.id} caseId={item.id} />
    {availableReviews.length === 0 ? <section className="review review-empty"><h3>更新案件狀態</h3><p>這個狀態目前沒有可執行的審核動作。</p></section> : <form className="review" onSubmit={submit}>
      <h3>更新案件狀態</h3>
      <p>只會顯示目前狀態可執行的動作；送出後會建立審核紀錄。</p>
      <div className="field"><label htmlFor="review-action">審核動作</label><select id="review-action" value={name} onChange={(event) => chooseReview(event.target.value)}><option value="" disabled>請選擇處理方式</option>{availableReviews.map((value) => <option value={value.action} key={value.action}>{value.label}</option>)}</select></div>
      {review?.supplement && <>
        <aside className={`review-callout review-callout--${review.supplement}`} aria-label={review.supplement === 'documents' ? '補件說明' : '退回修正說明'}>
          {review.supplement === 'documents' ? (
            <>
              <strong>要求補件：請申請人補上傳文件</strong>
              <p>適用於發票、身分證明、切結書等缺件或影像不清。申請人會看到上傳檔案畫面，不會被要求改寫申請內容。</p>
            </>
          ) : (
            <>
              <strong>退回修正：請申請人改申請內容</strong>
              <p>適用於用途、預算、工具或護照敘述有誤。申請人會看到修正說明與「前往修改」入口，不是補件上傳。</p>
            </>
          )}
        </aside>
        <div className="field"><label htmlFor="supplement-title">{review.supplement === 'documents' ? '補件項目（必填）' : '需修正項目（必填）'}</label><input id="supplement-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={review.supplement === 'documents' ? '例如：完整的購買發票' : '例如：申請用途寫法與實際流程不符'} /></div>
        <div className="field"><label htmlFor="supplement-instructions">{review.supplement === 'documents' ? '給申請人的補件說明（必填）' : '給申請人的修正說明（必填）'}</label><textarea id="supplement-instructions" rows={4} maxLength={10000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={review.supplement === 'documents' ? '請具體說明缺少的文件、內容或清晰度要求' : '請具體說明哪一段要改、正確應寫成什麼'} /></div>
        {review.supplement === 'correction' && <label className="choice"><input type="checkbox" checked={reconfirm} onChange={(event) => setReconfirm(event.target.checked)} />修正後請申請人重新確認申請內容</label>}
      </>}
      {review?.amount && <div className="field"><label htmlFor="approved-amount">{amountLabel}（新台幣，必填）</label><input id="approved-amount" type="number" inputMode="numeric" min="0" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>}
      {review?.reasonLabel && <div className="field"><label htmlFor="reason">{review.reasonLabel}（必填）</label><p id="reason-applicant-visible" className="field-hint">原因會被申請者看到</p><textarea id="reason" rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={review.reasonPlaceholder} aria-describedby="reason-applicant-visible" /></div>}
      {!review && <p className="review-guidance">選擇處理方式後，這裡會顯示所需資料與送出按鈕。</p>}
      {review && missing.length > 0 && <p className="review-requirements" role="status">尚需填寫：{missing.join('、')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {review && <button ref={confirmationTrigger} className={`primary${review.danger ? ' danger' : ''}`} aria-busy={busy} disabled={busy || missing.length > 0}>{busy ? '更新中…' : review.cta}</button>}
    </form>}
    {confirming && review && <dialog ref={confirmationDialog} className="review-confirm-dialog" aria-modal="true" aria-labelledby="review-confirm-title" onCancel={(event) => { event.preventDefault(); closeConfirmation(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeConfirmation(); } }}>
      <p className="eyebrow">送出前確認</p>
      <h4 id="review-confirm-title">確認{review.cta}</h4>
      <p>案件狀態將更新為「{label(review.toState)}」，並建立一筆審核紀錄。</p>
      <dl>
        <div><dt>執行動作</dt><dd>{review.label}</dd></div>
        {review.supplement && <><div><dt>{review.supplement === 'documents' ? '補件項目' : '需修正項目'}</dt><dd>{title.trim()}</dd></div><div><dt>給申請人的說明</dt><dd>{instructions.trim()}</dd></div></>}
        {review.supplement === 'correction' && <div><dt>申請人需重新確認</dt><dd>{reconfirm ? '是' : '否'}</dd></div>}
        {review.amount && <div><dt>{amountLabel}</dt><dd>{money(Number(amount))}</dd></div>}
        {review.reasonLabel && <div><dt>{review.reasonLabel}</dt><dd>{reason.trim()}</dd></div>}
      </dl>
      <div className="review-confirm-actions"><button type="button" className="secondary" data-initial-focus onClick={closeConfirmation}>返回修改</button><button type="button" className={`primary${review.danger ? ' danger' : ''}`} disabled={busy} aria-busy={busy} onClick={() => { closeConfirmation(); void update(review, decision); }}>{busy ? '更新中…' : `確認${review.cta}`}</button></div>
    </dialog>}
  </aside>;
}
