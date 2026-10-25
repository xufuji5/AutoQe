'use client'

declare function apiJson<T>(path: string, init?: unknown): Promise<T>

export function FlagToggle(): null {
  async function toggle(): Promise<void> {
    // 本仓统一的请求封装：泛型实参夹在名字与 `(` 之间
    await apiJson<{ ok: boolean }>('/api/flag', { method: 'POST', body: JSON.stringify({ on: true }) })
  }
  void toggle
  return null
}
