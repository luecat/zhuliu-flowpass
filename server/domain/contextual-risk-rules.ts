export type ContextualRisk = { ruleCode: string; severity: 'low' | 'medium' | 'high'; reasonCode: string };
export function evaluateContextualRisk(input: { containsPersonalData: boolean; containsHealthData?: boolean; publicDestination?: boolean; usesPlugin?: boolean; deletionPeriodDays?: number | null; accessControl?: boolean; deidentified?: boolean }): ContextualRisk[] {
  const risks: ContextualRisk[] = [];
  if (input.containsPersonalData) risks.push({ ruleCode: 'personal_data', severity: 'medium', reasonCode: 'personal_data_present' });
  if (input.containsHealthData) risks.push({ ruleCode: 'health_data', severity: 'high', reasonCode: 'health_data_present' });
  if (input.publicDestination) risks.push({ ruleCode: 'public_destination', severity: 'high', reasonCode: 'public_destination' });
  if (input.usesPlugin) risks.push({ ruleCode: 'plugin_use', severity: 'medium', reasonCode: 'plugin_use' });
  if (!input.deletionPeriodDays || input.deletionPeriodDays < 1) risks.push({ ruleCode: 'deletion_period', severity: 'medium', reasonCode: 'missing_deletion_period' });
  if (!input.accessControl) risks.push({ ruleCode: 'access_control', severity: 'medium', reasonCode: 'missing_access_control' });
  if (input.deidentified) risks.push({ ruleCode: 'deidentification', severity: 'low', reasonCode: 'deidentification_present' });
  return risks;
}
