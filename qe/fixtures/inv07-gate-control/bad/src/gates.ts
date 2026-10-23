// 坏样本：只有质检闸的服务端判据，库存闸的服务端判据缺失
export const QC_REPORT_REQUIRED = 'QC_REPORT_REQUIRED'

export function assertListingAllowed(input: { reportUrl?: string | null }): void {
  if (!input.reportUrl) throw new Error(QC_REPORT_REQUIRED)
}
