'use client'

export function RecallButton(): null {
  async function recall(q: string): Promise<void> {
    // 端点已到尽头，查询串用模板串直接拼 —— 结尾紧跟着的是 `${`，不是引号
    await fetch(`/api/recall${q ? `?q=${q}` : ''}`, { method: 'POST' })
  }
  void recall
  return null
}
