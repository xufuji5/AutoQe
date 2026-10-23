export const QC_REPORT_REQUIRED = 'QC_REPORT_REQUIRED'

export function assertListingAllowed(input: { qcReportUrl?: string | null }): void {
  if (!input.qcReportUrl) throw new Error(QC_REPORT_REQUIRED)
}
