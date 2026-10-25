export const APPROVAL_REPORT_REQUIRED = 'APPROVAL_REPORT_REQUIRED'

export function assertPublishAllowed(input: { reportUrl?: string | null }): void {
  if (!input.reportUrl) throw new Error(APPROVAL_REPORT_REQUIRED)
}
