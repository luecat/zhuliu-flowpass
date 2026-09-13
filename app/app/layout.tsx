import type { ReactNode } from 'react';
import { LiffApplicantGate, LiffSessionProvider } from '../components/public/liff-session-provider';

export default function ApplicantLayout({ children }: { children: ReactNode }) {
  return (
    <main className="applicant-shell">
      <LiffSessionProvider>
        <LiffApplicantGate>
          {children}
        </LiffApplicantGate>
      </LiffSessionProvider>
    </main>
  );
}
