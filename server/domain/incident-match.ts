export type IncidentMatch = { matched: boolean; status: 'possible' | 'confirmed_affected' | 'not_affected'; basis: string[] };
export function matchIncident(input: { toolName: string; toolVersion?: string | null; aliases?: string[]; affectedVersions?: string[]; usageAt?: string | null; incidentStartAt?: string | null; incidentEndAt?: string | null; effective: boolean }): IncidentMatch {
  if (!input.effective) return { matched: false, status: 'not_affected', basis: [] };
  const names = new Set([input.toolName, ...(input.aliases ?? [])].map((value) => value.trim().toLowerCase()).filter(Boolean));
  const nameMatch = names.size > 0;
  const versionMatch = !input.affectedVersions?.length || !input.toolVersion || input.affectedVersions.includes(input.toolVersion);
  const time = input.usageAt ? Date.parse(input.usageAt) : NaN; const start = input.incidentStartAt ? Date.parse(input.incidentStartAt) : -Infinity; const end = input.incidentEndAt ? Date.parse(input.incidentEndAt) : Infinity;
  const timeMatch = input.usageAt ? (!Number.isNaN(time) && time >= start && time <= end) : true;
  if (!nameMatch || !versionMatch || !timeMatch) return { matched: false, status: 'not_affected', basis: [] };
  return { matched: true, status: input.toolVersion ? 'possible' : 'possible', basis: [input.toolVersion ? 'tool_and_version' : 'tool_version_unknown', input.usageAt ? 'usage_date' : 'usage_date_unknown'] };
}
