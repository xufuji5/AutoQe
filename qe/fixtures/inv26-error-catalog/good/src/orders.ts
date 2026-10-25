export class ApiError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

export function assertUnlocked(locked: boolean): void {
  if (locked) throw new ApiError('ORDER_LOCKED')
}
