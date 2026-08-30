export interface PublicProgramRule {
  id: string;
  versionNo: number;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  purchaseStartAt: string | null;
  purchaseEndAt: string | null;
  requiredDocuments: string[];
}

export interface PublicProgram {
  id: string;
  code: string;
  name: string;
  year: number;
  applicationWindow: { startAt: string | null; endAt: string | null };
  eligiblePurchaseWindow: { startAt: string | null; endAt: string | null };
  requirements: { requiredDocuments: string[] };
  rule: PublicProgramRule;
}

export type RuleOutcome = 'pass' | 'fail' | 'needs_review' | 'missing';
export interface RuleStep { label: string; value: string; }
export interface RuleEvaluation { ruleCode: string; outcome: RuleOutcome; reasonCode: string; explanation: string; ruleVersionId: string; inputSnapshotHash: string; evaluatedAt: string; steps: RuleStep[]; }
export interface SubsidyCalculation { eligiblePurchaseTwd: number; rateBps: number; capTwd: number; calculatedAmountTwd: number; roundingMode: 'floor' | 'half_up'; reasonCode: string; }
