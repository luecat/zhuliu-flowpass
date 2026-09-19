import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { record, string, number, attachmentOf } from './parsers';
import type { Attachment } from './types';
import { money } from './format';

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
  nationalId?: string | null;
  householdAddress?: string | null;
};

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
    nationalId: string(v.nationalId) ?? null,
    householdAddress: string(v.householdAddress) ?? null,
  };
}

function currencyLabel(details: PurchaseDetails) {
  return details.originalCurrency === 'OTHER' ? details.otherCurrency ?? '其他幣別' : details.originalCurrency;
}

function documentUrl(id: string) {
  return `/admin/v1/documents/${encodeURIComponent(id)}/content`;
}

export function PurchaseReview({ caseId }: { caseId: string }) {
  const [details, setDetails] = useState<PurchaseDetails | null>(null);
  const [invoices, setInvoices] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [zoomed, setZoomed] = useState<Attachment | null>(null);
  const lightbox = useRef<HTMLDialogElement>(null);
  const lightboxCloseButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(caseId)}/purchase-details`),
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(caseId)}/documents`),
    ]).then(([purchaseValue, documentsValue]) => {
      if (!active) return;
      setDetails(purchaseDetailsOf(record(purchaseValue).purchaseDetails ?? null));
      const documents = record(documentsValue);
      const attachments = (Array.isArray(documents.documents) ? documents.documents : []).map(attachmentOf).filter((item): item is Attachment => item !== null);
      setInvoices(attachments.filter((item) => item.kind === 'invoice' && item.status === 'ready'));
    }).catch(() => { if (active) setError('購買資訊暫時無法載入，請重新整理後再試。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId]);
  useEffect(() => {
    if (!zoomed) return;
    const dialog = lightbox.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const timer = window.setTimeout(() => lightboxCloseButton.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [zoomed]);
  const closeZoom = () => {
    const dialog = lightbox.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    setZoomed(null);
  };
  return <section className="purchase-review" aria-labelledby="purchase-review-title">
    <div className="attachments-head"><h3 id="purchase-review-title">購買資訊核對</h3>{loading && <span role="status">載入中…</span>}</div>
    {error ? <p className="error" role="alert">{error}</p> : !loading && !details ? <p className="attachments-empty">申請人尚未填寫購買資訊。</p> : details && <>
      <dl className="purchase-review-fields">
        <div><dt>軟體名稱</dt><dd>{details.softwareName ?? '—'}</dd></div>
        <div><dt>供應商</dt><dd>{details.companyName ?? '—'}</dd></div>
        <div><dt>購買日期</dt><dd>{details.purchaseDate ?? '—'}</dd></div>
        <div><dt>發票號碼</dt><dd>{details.invoiceNumber ?? '未填寫'}</dd></div>
        <div><dt>原始金額</dt><dd>{details.originalExpense ?? '—'} {currencyLabel(details)}</dd></div>
        <div><dt>銀行付款實付台幣</dt><dd>{money(details.convertedTwd)}</dd></div>
        <div><dt>收據買受人</dt><dd>{details.receiptBuyerName ?? '尚未辨識'}</dd></div>
        <div><dt>申請人姓名</dt><dd>{details.applicantName ?? '—'}</dd></div>
        <div><dt>身分證字號</dt><dd>{details.nationalId ?? '—'}</dd></div>
        <div><dt>戶籍地址</dt><dd>{details.householdAddress ?? '—'}</dd></div>
      </dl>
      <div className="purchase-review-evidence">
        {invoices.length === 0 ? <p className="attachments-empty">尚無發票／購買憑證影像可供核對。</p> : invoices.map((invoice) => <figure className="purchase-review-thumb" key={invoice.id}>
          <button type="button" className="purchase-review-thumb-button" onClick={() => setZoomed(invoice)} aria-label={`放大檢視 ${invoice.originalName}`}>
            {invoice.mediaType === 'application/pdf'
              ? <span className="purchase-review-thumb-pdf">PDF</span>
              // The admin app is a Vite SPA, not Next.js; there is no next/image here to switch to.
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={documentUrl(invoice.id)} alt="" />}
          </button>
          <figcaption>{invoice.originalName}</figcaption>
        </figure>)}
      </div>
    </>}
    {zoomed && <dialog ref={lightbox} className="purchase-review-lightbox" aria-label={`檢視附件 ${zoomed.originalName}`} onCancel={(event) => { event.preventDefault(); closeZoom(); }} onClick={(event) => { if (event.target === lightbox.current) closeZoom(); }}>
      <div className="purchase-review-lightbox-inner">
        <header><span>{zoomed.originalName}</span><button ref={lightboxCloseButton} type="button" className="close" onClick={closeZoom} aria-label="關閉放大檢視">×</button></header>
        {zoomed.mediaType === 'application/pdf'
          ? <iframe src={documentUrl(zoomed.id)} title={zoomed.originalName} />
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={documentUrl(zoomed.id)} alt={zoomed.originalName} />}
      </div>
    </dialog>}
  </section>;
}
