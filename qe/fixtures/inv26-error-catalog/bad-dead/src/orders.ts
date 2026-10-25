export class ApiError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

// 坏样本：册面登记的那个码在这里没有任何抛错点（注释里不得出现码面字面量，否则正向判据被注释骗过）
export function assertUnlocked(locked: boolean): void {
  if (locked) throw new ApiError('ORDER_LOCKED')
}
