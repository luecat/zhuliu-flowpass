import { ApplicantCaseDetail } from '../../../components/public/applicant-case-detail';

export default async function PassportCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <ApplicantCaseDetail caseId={caseId} />;
}
