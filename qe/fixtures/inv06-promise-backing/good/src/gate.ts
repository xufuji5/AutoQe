export const APPROVAL_REPORT_REQUIRED = 'APPROVAL_REPORT_REQUIRED'

export function assertPublishAllowed(input: { approvalReportUrl?: string | null }): void {
  if (!input.approvalReportUrl) throw new Error(APPROVAL_REPORT_REQUIRED)
}
