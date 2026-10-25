// 坏样本：只有审核闸的服务端判据，配额闸的服务端判据缺失
export const APPROVAL_REPORT_REQUIRED = 'APPROVAL_REPORT_REQUIRED'

export function assertPublishAllowed(input: { reportUrl?: string | null }): void {
  if (!input.reportUrl) throw new Error(APPROVAL_REPORT_REQUIRED)
}
