import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Case, Review, ReviewDecision } from './types';
import { REVIEWS } from './types';
import { label, money } from './format';

export type SavedDocumentIssue = { key: string; label: string; reason: string };

function reviewOptionLabel(review: Review, state: string) {
  if (review.action === 'start_review' && ['awaiting_documents', 'returned_for_correction'].includes(state)) {
    return '繼續審核';
  }
  return review.label;
}

function defaultAmountForReview(review: Review | undefined, item: Case): string {
  if (!review?.amount) return '';
  if (review.amount === 'disbursed') {
    return (item.disbursedAmountTwd ?? item.approvedAmountTwd ?? item.calculatedAmountTwd)?.toString() ?? '';
  }
  // Prefer an already-approved figure; otherwise fall back to the system subsidy estimate.
  return (item.approvedAmountTwd ?? item.calculatedAmountTwd)?.toString() ?? '';
}

export function ReviewActions({
  item,
  busy,
  error,
  clearError,
  update,
  toolbar = false,
  savedDocumentIssues = [],
  onUseSavedDocumentIssues,
}: {
  item: Case;
  busy: boolean;
  error: string;
  clearError: () => void;
  update: (review: Review, decision: ReviewDecision) => Promise<void>;
  toolbar?: boolean;
  savedDocumentIssues?: SavedDocumentIssue[];
  onUseSavedDocumentIssues?: () => void;
}) {
  const availableReviews = REVIEWS.filter((value) => value.fromStates.includes(item.state));
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(item.approvedAmountTwd?.toString() ?? item.calculatedAmountTwd?.toString() ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [confirming, setConfirming] = useState(false);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const review = availableReviews.find((value) => value.action === name);
  const amountLabel = review?.amount === 'disbursed' ? '匯款金額' : '核准金額';
  const usingSavedIssues = review?.action === 'request_documents' && savedDocumentIssues.length > 0;
  const startReason = ['awaiting_documents', 'returned_for_correction'].includes(item.state) ? '繼續審查' : '開始審查';
  const estimatedAmount = item.calculatedAmountTwd;

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

  useEffect(() => {
    if (!toolbar || !name || confirming) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (formRef.current?.contains(target)) return;
      if (document.querySelector('dialog[open]')?.contains(target)) return;
      setName('');
      setReason('');
      setTitle('');
      setInstructions('');
      setAmount(item.approvedAmountTwd?.toString() ?? item.calculatedAmountTwd?.toString() ?? '');
      clearError();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [toolbar, name, confirming, item.approvedAmountTwd, item.calculatedAmountTwd, clearError]);

  const amountIsValid = amount.trim().length > 0 && Number.isSafeInteger(Number(amount)) && Number(amount) >= 0;
  const missing: string[] = [];
  if (review?.supplement && !usingSavedIssues) {
    if (!title.trim()) missing.push('補件項目');
    if (!instructions.trim()) missing.push('給申請人的補件說明');
  } else if (review && !usingSavedIssues) {
    if (review.amount && !amountIsValid) missing.push(amountLabel);
    if (review.reasonLabel && !reason.trim()) missing.push(review.reasonLabel);
  }
  const decision: ReviewDecision = review?.supplement
    ? {
        reason: instructions.trim(),
        title: title.trim(),
        instructions: instructions.trim(),
      }
    : {
        ...(review?.action === 'start_review'
          ? { reason: startReason }
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
    setAmount(defaultAmountForReview(nextReview, item));
    setTitle('');
    setInstructions('');
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
    if (!review || busy) return;
    if (usingSavedIssues) {
      onUseSavedDocumentIssues?.();
      return;
    }
    if (missing.length > 0) return;
    if (review.confirm) setConfirming(true);
    else void update(review, decision);
  };

  if (availableReviews.length === 0) {
    return (
      <p className="tian-toolbar-empty" role="status">
        目前狀態「{label(item.state)}」沒有可執行的處理方式。
      </p>
    );
  }

  const fields = (
    <>
      {review?.supplement && !usingSavedIssues && (
        <>
          <aside className="review-callout review-callout--documents" aria-label="補件說明">
            <strong>要求補件：請申請人補上傳文件</strong>
            <p>適用於發票、身分證明、切結書等缺件或影像不清。申請人會看到上傳檔案畫面，不會被要求改寫申請內容。</p>
          </aside>
          <div className="field">
            <label htmlFor={toolbar ? 'tian-supplement-title' : 'supplement-title'}>補件項目（必填）</label>
            <input
              id={toolbar ? 'tian-supplement-title' : 'supplement-title'}
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：完整的購買發票"
            />
          </div>
          <div className="field">
            <label htmlFor={toolbar ? 'tian-supplement-instructions' : 'supplement-instructions'}>
              給申請人的補件說明（必填）
            </label>
            <textarea
              id={toolbar ? 'tian-supplement-instructions' : 'supplement-instructions'}
              rows={toolbar ? 3 : 4}
              maxLength={10000}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="請具體說明缺少的文件、內容或清晰度要求"
            />
          </div>
        </>
      )}
      {review?.amount && (
        <div className="field">
          <label htmlFor={toolbar ? 'tian-approved-amount' : 'approved-amount'}>{amountLabel}（新台幣，必填）</label>
          <input
            id={toolbar ? 'tian-approved-amount' : 'approved-amount'}
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          {typeof estimatedAmount === 'number' && (
            <p className="field-hint">
              系統試算：{money(estimatedAmount)}
              {amount.trim() === String(estimatedAmount) ? '（已帶入）' : ''}
              {amount.trim() && amount.trim() !== String(estimatedAmount) ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => setAmount(String(estimatedAmount))}
                  >
                    改用試算金額
                  </button>
                </>
              ) : null}
            </p>
          )}
        </div>
      )}
      {review?.reasonLabel && (
        <div className="field">
          <label htmlFor={toolbar ? 'tian-reason-field' : 'reason'}>{review.reasonLabel}（必填）</label>
          <p id={toolbar ? 'tian-reason-applicant-visible' : 'reason-applicant-visible'} className="field-hint">
            原因會被申請者看到
          </p>
          <textarea
            id={toolbar ? 'tian-reason-field' : 'reason'}
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={review.reasonPlaceholder}
            aria-describedby={toolbar ? 'tian-reason-applicant-visible' : 'reason-applicant-visible'}
          />
        </div>
      )}
      {!review && <p className="review-guidance">選擇處理方式後，這裡會顯示所需資料。</p>}
      {review && missing.length > 0 && (
        <p className="review-requirements" role="status">
          尚需填寫：{missing.join('、')}
        </p>
      )}
      {usingSavedIssues && (
        <p className="tian-toolbar-hint" role="status">
          將使用已儲存的 {savedDocumentIssues.length} 項補件原因。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );

  const confirmDialog =
    confirming && review ? (
      <dialog
        ref={confirmationDialog}
        className="review-confirm-dialog"
        aria-modal="true"
        aria-labelledby="review-confirm-title"
        onCancel={(event) => {
          event.preventDefault();
          closeConfirmation();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeConfirmation();
          }
        }}
      >
        <p className="eyebrow">確認前核對</p>
        <h4 id="review-confirm-title">確認{review.cta}</h4>
        <p>
          案件狀態將更新為「{label(review.toState)}」，並建立一筆審核紀錄。
        </p>
        <dl>
            <div>
              <dt>執行動作</dt>
              <dd>{reviewOptionLabel(review, item.state)}</dd>
            </div>
          {review.supplement && (
            <>
              <div>
                <dt>補件項目</dt>
                <dd>{title.trim()}</dd>
              </div>
              <div>
                <dt>給申請人的說明</dt>
                <dd>{instructions.trim()}</dd>
              </div>
            </>
          )}
          {review.amount && (
            <div>
              <dt>{amountLabel}</dt>
              <dd>{money(Number(amount))}</dd>
            </div>
          )}
          {review.reasonLabel && (
            <div>
              <dt>{review.reasonLabel}</dt>
              <dd>{reason.trim()}</dd>
            </div>
          )}
        </dl>
        <div className="review-confirm-actions">
          <button type="button" className="secondary" data-initial-focus onClick={closeConfirmation}>
            返回修改
          </button>
          <button
            type="button"
            className={`primary${review.danger ? ' danger' : ''}`}
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              closeConfirmation();
              void update(review, decision);
            }}
          >
            {busy ? '更新中…' : `確認${review.cta}`}
          </button>
        </div>
      </dialog>
    ) : null;

  if (toolbar) {
    const needsTray =
      Boolean(review) &&
      (usingSavedIssues ||
        Boolean(review?.supplement) ||
        Boolean(review?.amount) ||
        Boolean(review?.reasonLabel) ||
        missing.length > 0 ||
        Boolean(error));

    return (
      <>
        <form ref={formRef} className={`tian-toolbar-form${needsTray ? ' has-tray' : ''}`} onSubmit={submit}>
          <div className="tian-toolbar-row">
            <label className="sr" htmlFor="tian-review-action">
              審核動作
            </label>
            <select id="tian-review-action" value={name} onChange={(event) => chooseReview(event.target.value)}>
              <option value="" disabled>
                請選擇處理方式
              </option>
              {availableReviews.map((value) => (
                <option value={value.action} key={value.action}>
                  {reviewOptionLabel(value, item.state)}
                </option>
              ))}
            </select>
            <button
              ref={confirmationTrigger}
              type="submit"
              className={`primary tian-complete${review?.danger ? ' danger' : ''}`}
              aria-busy={busy}
              disabled={!review || busy || missing.length > 0}
            >
              {busy ? '更新中…' : '完成'}
            </button>
          </div>
          {needsTray && <div className="tian-review-tray">{fields}</div>}
        </form>
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <form className="review" onSubmit={submit}>
        <h3>更新案件狀態</h3>
        <p>只會顯示目前狀態可執行的動作；確認後會建立審核紀錄。</p>
        <div className="field">
          <label htmlFor="review-action">審核動作</label>
          <select id="review-action" value={name} onChange={(event) => chooseReview(event.target.value)}>
            <option value="" disabled>
              請選擇處理方式
            </option>
            {availableReviews.map((value) => (
              <option value={value.action} key={value.action}>
                {reviewOptionLabel(value, item.state)}
              </option>
            ))}
          </select>
        </div>
        {fields}
        {review && (
          <button
            ref={confirmationTrigger}
            className={`primary${review.danger ? ' danger' : ''}`}
            aria-busy={busy}
            disabled={busy || missing.length > 0}
          >
            {busy ? '更新中…' : review.cta}
          </button>
        )}
      </form>
      {confirmDialog}
    </>
  );
}
