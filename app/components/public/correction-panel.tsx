'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { formatTaipeiDate } from './applicant-case-status';

interface CorrectionTask {
  id: string;
  taskType: string;
  title: string;
  instructions: string;
  dueAt: string | null;
  createdAt: string;
  rowVersion: number;
}

export function CorrectionPanel({ caseId, onCompleted }: { caseId: string; onCompleted: () => void | Promise<void> }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [task, setTask] = useState<CorrectionTask | null>(null);
  const [reconfirmTask, setReconfirmTask] = useState<CorrectionTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const taskResult = await api.read<{ tasks: CorrectionTask[] }>(`/api/v1/tasks?caseId=${encodeURIComponent(caseId)}`);
    setTask(taskResult.tasks.find((item) => item.taskType === 'revise_passport') ?? null);
    setReconfirmTask(taskResult.tasks.find((item) => item.taskType === 'reconfirm_passport') ?? null);
  }, [api, caseId]);

  useEffect(() => {
    let active = true;
    void load()
      .catch(() => { if (active) setMessage('修正說明暫時無法載入，請稍後再試。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  async function submit() {
    if (!task || !confirmed) return;
    setSubmitting(true);
    setMessage('');
    try {
      await api.mutate(`/api/v1/tasks/${encodeURIComponent(task.id)}/complete`, {
        method: 'POST',
        ifMatch: `"${task.rowVersion}"`,
        body: { action: 'revise_passport' },
      });
      if (reconfirmTask) {
        await api.mutate(`/api/v1/tasks/${encodeURIComponent(reconfirmTask.id)}/complete`, {
          method: 'POST',
          ifMatch: `"${reconfirmTask.rowVersion}"`,
          body: { action: 'reconfirm_passport' },
        });
      }
      await onCompleted();
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.code === 'ETAG_MISMATCH'
        ? '內容已更新，請重新整理後再送出。'
        : '修正尚未送出，請確認已依說明改完後再試。');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <section className="applicant-supplement" aria-label="修正申請內容">
        <p className="pending-note" role="status">正在載入修正說明…</p>
      </section>
    );
  }

  if (!task) {
    return (
      <section className="applicant-supplement applicant-supplement--error" aria-label="修正申請內容">
        <h2>修正說明暫時無法顯示</h2>
        <p>請重新整理頁面；若仍無法顯示，請聯絡承辦人員。</p>
      </section>
    );
  }

  return (
    <section className="applicant-supplement applicant-correction" aria-labelledby="correction-title">
      <header>
        <p className="eyebrow">需要你修改內容</p>
        <h2 id="correction-title">請修正申請資料</h2>
        <p>這次是「退回修正」，不是補上傳文件。請依承辦說明改掉申請內容後再送回。</p>
      </header>

      <div className="applicant-supplement-request applicant-correction-request">
        <strong>{task.title}</strong>
        <p>{task.instructions}</p>
        {task.dueAt && <small>請於 {formatTaipeiDate(task.dueAt, true)} 前完成</small>}
      </div>

      <div className="applicant-correction-steps">
        <p><strong>你可以這樣做</strong></p>
        <ol>
          <li>打開申請內容，依上方說明修改填寫或護照確認資料。</li>
          <li>確認修改後的內容正確。</li>
          <li>回到這裡勾選並送出，案件會回到審核佇列。</li>
        </ol>
        <Link className="secondary-action" href={`/app/apply?caseId=${encodeURIComponent(caseId)}`}>
          前往修改申請內容
        </Link>
      </div>

      {message && <p className="pending-note" role="status">{message}</p>}

      <label className="choice applicant-correction-confirm">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        我已依說明完成修正{reconfirmTask ? '，並重新確認申請內容' : ''}
      </label>

      <button
        type="button"
        className="primary-action applicant-supplement-submit"
        disabled={!confirmed || submitting}
        onClick={() => { void submit(); }}
      >
        {submitting ? '送出中…' : '送出修正'}
      </button>
    </section>
  );
}
