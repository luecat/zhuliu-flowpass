import type { ReactNode } from 'react';

export default function ApplicantLayout({ children }: { children: ReactNode }) {
  return <main className="applicant-shell">{children}</main>;
}
