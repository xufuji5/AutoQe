'use client'

// 末段由运行时变量决定：字面量只能证到 /api/ticket/<某值>/ 为止
export function ActionBar({ id }: { id: string }): null {
  async function act(action: string): Promise<void> {
    await fetch(`/api/ticket/${id}/${action}`, { method: 'POST' })
  }
  void act
  return null
}
