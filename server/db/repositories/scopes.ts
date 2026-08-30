export interface ApplicantScope {
  applicantId: string;
}

export interface AdminScope {
  adminId: string;
}

export interface SystemScope {
  systemId: string;
}

export function requireApplicantScope(scope: ApplicantScope): void {
  if (!scope.applicantId) {
    throw new Error('applicant scope is required');
  }
}

export function requireAdminScope(scope: AdminScope): void {
  if (!scope.adminId) {
    throw new Error('admin scope is required');
  }
}

export function requireSystemScope(scope: SystemScope): void {
  if (!scope.systemId) {
    throw new Error('system scope is required');
  }
}
