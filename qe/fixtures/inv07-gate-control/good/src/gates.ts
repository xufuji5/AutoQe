export const QC_REPORT_REQUIRED = 'QC_REPORT_REQUIRED'
export const STOCK_INSUFFICIENT = 'STOCK_INSUFFICIENT'

export function assertListingAllowed(input: { qcReportUrl?: string | null }): void {
  if (!input.qcReportUrl) throw new Error(QC_REPORT_REQUIRED)
}

export function assertStock(stock: number): void {
  if (stock <= 0) throw new Error(STOCK_INSUFFICIENT)
}
