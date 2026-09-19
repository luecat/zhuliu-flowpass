import { useEffect, useState } from 'react';
import { api } from './api';
import { record, attachmentOf } from './parsers';
import type { Attachment } from './types';
import { bytes, date } from './format';

export function Attachments({ caseId }: { caseId: string }) {
  const [documents, setDocuments] = useState<Attachment[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<unknown>(`/admin/v1/cases/${encodeURIComponent(caseId)}/documents`).then((value) => {
      if (!active) return;
      const data = record(value);
      setDocuments((Array.isArray(data.documents) ? data.documents : []).map(attachmentOf).filter((item): item is Attachment => item !== null));
    }).catch(() => { if (active) setError('附件暫時無法載入，請重新整理後再試。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId]);
  const requirementLabels: Record<string, string> = { identity_front: '身分證正面', identity_back: '身分證反面', special_status_proof: '資格證明', purchase_proof: '購買憑證或發票', passbook_cover: '存摺封面影本', affidavit: '切結書', representative_affidavit: '代付切結書' };
  const kindLabels: Record<string, string> = { invoice: '發票／購買憑證', eligibility_proof: '資格證明', supplement: '補充文件', other: '其他附件' };
  const statusLabels: Record<string, string> = { ready: '可開啟', pending_vault: '儲存中', processing: '處理中', rejected: '無法使用' };
  return <section className="attachments" aria-labelledby="attachments-title"><div className="attachments-head"><h3 id="attachments-title">附件（{documents.length}）</h3>{loading && <span role="status">載入中…</span>}</div>{error ? <p className="error" role="alert">{error}</p> : !loading && documents.length === 0 ? <p className="attachments-empty">這筆案件目前沒有附件。</p> : <ul>{documents.map((document) => <li key={document.id}><div><strong>{document.originalName}</strong><small>{requirementLabels[document.requirementKey ?? ''] ?? kindLabels[document.kind] ?? '附件'} · {bytes(document.byteSize)} · {date(document.createdAt)}</small></div><div className="attachment-actions"><span className={`attachment-status attachment-${document.status}`}>{statusLabels[document.status] ?? document.status}</span>{document.status === 'ready' && <a href={`/admin/v1/documents/${encodeURIComponent(document.id)}/content`} target="_blank" rel="noopener noreferrer" aria-label={`開啟附件 ${document.originalName}`}>開啟附件</a>}</div></li>)}</ul>}</section>;
}
