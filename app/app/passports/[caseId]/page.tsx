import { CaseTimeline } from '../../../components/public/case-timeline';
import { PassportReviewPanel } from '../../../components/public/passport-review-panel';
import { PassportHistory } from '../../../components/public/passport-history';
import { SecurityAlerts } from '../../../components/public/security-alerts';

export default async function PassportCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <section><nav aria-label="案件分頁"><a href="#timeline">申請進度</a> · <a href="#flow">資料流向</a> · <a href="#alerts">資安提醒</a> · <a href="#history">護照紀錄</a></nav><h1>案件護照</h1><section id="timeline"><CaseTimeline caseId={caseId} /></section><section id="flow"><h2>資料流向</h2><PassportReviewPanel caseId={caseId} /></section><section id="alerts"><h2>資安提醒</h2><SecurityAlerts caseId={caseId} /></section><section id="history"><PassportHistory caseId={caseId} /></section></section>;
}
