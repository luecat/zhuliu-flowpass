'use client';

import { useEffect, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';

type Version = { id: string; versionNo: number; origin: string; workflowState: string; schemaVersion: string; createdAt: string };

export function PassportHistory({ caseId }: { caseId: string }) {
  const [versions, setVersions] = useState<Version[]>([]);
  useEffect(() => {
    void new PublicApiClient().read<{ versions: Version[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/passport?history=1`).then((value) => setVersions(value.versions)).catch(() => undefined);
  }, [caseId]);
  return <section aria-labelledby="passport-history-title"><h2 id="passport-history-title">護照版本紀錄</h2>{versions.length === 0 ? <p>尚無可顯示的版本紀錄。</p> : <ol>{versions.map((version) => <li key={version.id}><strong>第 {version.versionNo} 版</strong> · {version.workflowState} · {version.origin} · <time dateTime={version.createdAt}>{version.createdAt}</time></li>)}</ol>}</section>;
}
