'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { bootLineLiffSession, loadLiffBrowserSdk } from '../../lib/liff-client';
import { PublicApiClient } from '../../lib/public-api';

type LiffSessionStatus = 'loading' | 'redirecting' | 'authenticated' | 'unavailable' | 'timeout';

interface LiffSessionValue {
  api: PublicApiClient | null;
  status: LiffSessionStatus;
  message: string;
  retry: () => void;
}

const LiffSessionContext = createContext<LiffSessionValue | null>(null);
const LOGIN_TIMEOUT_MS = 20_000;

export function LiffSessionProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const liffId = process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID;
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<LiffSessionValue>(() => liffId ? {
    api,
    status: 'loading',
    message: '確認 LINE 登入狀態中…',
    retry: () => undefined,
  } : {
    api: null,
    status: 'unavailable',
    message: 'LINE 申請入口尚未設定。',
    retry: () => undefined,
  });

  useEffect(() => {
    if (!liffId) return;
    let cancelled = false;
    const retry = () => setAttempt((current) => current + 1);
    setValue({
      api,
      status: 'loading',
      message: '確認 LINE 登入狀態中…',
      retry,
    });
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setValue({
        api: null,
        status: 'timeout',
        message: '登入逾時。請確認網路連線，或由 LINE 官方帳號重新開啟。',
        retry,
      });
    }, LOGIN_TIMEOUT_MS);

    void loadLiffBrowserSdk()
      .then((liff) => bootLineLiffSession({ liff, api, config: { liffId } }))
      .then((result) => {
        if (cancelled) return;
        window.clearTimeout(timeout);
        if (result.kind === 'authenticated') {
          const next = new URLSearchParams(window.location.search).get('next');
          if (next === 'apply') {
            window.location.replace('/app/apply');
            return;
          }
          if (next === 'passports') {
            window.location.replace('/app/passports');
            return;
          }
          if (next === 'tool-status' || next === 'tool-check') {
            window.location.replace('/app/tool-check');
            return;
          }
          if (next === 'tasks') {
            window.location.replace('/app/tasks');
            return;
          }
        }
        setValue(
          result.kind === 'authenticated'
            ? { api, status: 'authenticated', message: '', retry }
            : { api, status: 'redirecting', message: '轉往 LINE 登入中…', retry },
        );
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(timeout);
        setValue({
          api: null,
          status: 'unavailable',
          message: '請由竹流 FlowPass 的 LINE 官方帳號選單開啟此頁。',
          retry,
        });
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [api, attempt, liffId]);

  return <LiffSessionContext.Provider value={value}>{children}</LiffSessionContext.Provider>;
}

export function useLiffSession(): LiffSessionValue {
  return useContext(LiffSessionContext) ?? {
    api: null,
    status: 'unavailable',
    message: '請由竹流 FlowPass 的 LINE 官方帳號選單開啟此頁。',
    retry: () => undefined,
  };
}

export function LiffApplicantGate({ children }: { children: ReactNode }) {
  const session = useLiffSession();
  if (session.status === 'authenticated') return <>{children}</>;
  const title = session.status === 'unavailable' || session.status === 'timeout'
    ? '請由 LINE 官方帳號開啟'
    : 'LINE 登入中';
  return (
    <section className="liff-session-gate" aria-live="polite">
      <p className="eyebrow">竹流 FlowPass</p>
      <h1>{title}</h1>
      <p role="status">{session.message}</p>
      {(session.status === 'unavailable' || session.status === 'timeout') && (
        <div className="wizard-actions">
          <button type="button" className="primary-action" onClick={() => session.retry()}>重新登入</button>
          <a className="secondary-action" href="https://line.me/R/ti/p/@flowpass" rel="noreferrer">返回 LINE</a>
        </div>
      )}
    </section>
  );
}
