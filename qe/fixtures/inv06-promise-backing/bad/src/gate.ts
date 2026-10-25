// 坏样本：册面承诺「审核闸门」，源码只有一句弱提示，没有任何抛错点
export function hintPublish(approvalReportUrl?: string | null): string {
  return approvalReportUrl ? 'ok' : '请补充审核报告'
}
