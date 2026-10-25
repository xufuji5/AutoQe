export class ApiError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

// 坏样本：抛出的 UNLISTED 从未登记进 errorCatalog（野生码）
export function assertUnlocked(locked: boolean): void {
  if (locked) throw new ApiError('UNLISTED')
}
