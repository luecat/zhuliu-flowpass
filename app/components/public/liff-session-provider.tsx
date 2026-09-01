'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { bootLineLiffSession, loadLiffBrowserSdk } from '../../lib/liff-client';
import { PublicApiClient } from '../../lib/public-api';

type LiffSessionStatus = 'loading' | 'redirecting' | 'authenticated' | 'unavailable';

interface LiffSessionValue {
  api: PublicApiClient | null;
  status: LiffSessionStatus;
  message: string;
}

const LiffSessionContext = createContext<LiffSessionValue | null>(null);

export function LiffSessionProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const liffId = process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID;
  const [value, setValue] = useState<LiffSessionValue>(() => liffId ? {
    api,
    status: 'loading',
    message: '正在確認 LINE 登入…',
  } : {
    api: null,
    status: 'unavailable',
    message: 'LINE 申請入口尚未設定。',
  });

  useEffect(() => {
    if (!liffId) return;
    let cancelled = false;
    void loadLiffBrowserSdk()
      .then((liff) => bootLineLiffSession({ liff, api, config: { liffId } }))
      .then((result) => {
        if (cancelled) return;
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
          if (next === 'tasks') {
            window.location.replace('/app/tasks');
            return;
          }
        }
        setValue(
          result.kind === 'authenticated'
            ? { api, status: 'authenticated', message: '' }
            : { api, status: 'redirecting', message: '正在轉往 LINE 登入…' },
        );
      })
      .catch(() => {
        if (!cancelled) {
          setValue({
            api: null,
            status: 'unavailable',
            message: '請從竹流 FlowPass 的 LINE 官方帳號選單開啟此頁。',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, liffId]);

  return <LiffSessionContext.Provider value={value}>{children}</LiffSessionContext.Provider>;
}

export function useLiffSession(): LiffSessionValue {
  return useContext(LiffSessionContext) ?? {
    api: null,
    status: 'unavailable',
    message: '請從竹流 FlowPass 的 LINE 官方帳號選單開啟此頁。',
  };
}

export function LiffApplicantGate({ children }: { children: ReactNode }) {
  const session = useLiffSession();
  if (session.status === 'authenticated') return <>{children}</>;
  return (
    <section className="liff-session-gate" aria-live="polite">
      <p className="eyebrow">竹流 FlowPass</p>
      <h1>{session.status === 'unavailable' ? '請從 LINE 官方帳號開啟' : 'LINE 登入中'}</h1>
      <p role="status">{session.message}</p>
    </section>
  );
}
