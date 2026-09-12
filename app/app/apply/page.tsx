import { ApplicationWizard } from '../../components/public/application-wizard';
import { PassportReviewPanel } from '../../components/public/passport-review-panel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function ApplyPage() { return <><ApplicationWizard /><PassportReviewPanel /></>; }
