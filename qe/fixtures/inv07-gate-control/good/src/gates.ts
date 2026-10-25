export const APPROVAL_REPORT_REQUIRED = 'APPROVAL_REPORT_REQUIRED'
export const QUOTA_INSUFFICIENT = 'QUOTA_INSUFFICIENT'

export function assertPublishAllowed(input: { reportUrl?: string | null }): void {
  if (!input.reportUrl) throw new Error(APPROVAL_REPORT_REQUIRED)
}

export function assertQuota(quota: number): void {
  if (quota <= 0) throw new Error(QUOTA_INSUFFICIENT)
}
