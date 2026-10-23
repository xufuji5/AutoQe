// 坏样本：册面承诺「质检闸门」，源码只有一句弱提示，没有任何抛错点
export function hintListing(qcReportUrl?: string | null): string {
  return qcReportUrl ? 'ok' : '请补充质检报告'
}
