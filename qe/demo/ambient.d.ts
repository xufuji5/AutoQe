/** 示例仓的第三方类型替身：demo 只用于让守卫有真实形状，不参与运行 */
declare module 'zustand' {
  export function create<T>(initializer: T): T
}

declare module 'zustand/middleware' {
  export function persist<T>(
    config: T,
    options?: {
      name?: string
      version?: number
      partialize?: (state: Record<string, unknown>) => Record<string, unknown>
      [key: string]: unknown
    },
  ): T
}

declare module 'zod' {
  interface ZodType {
    parse(value: unknown): unknown
  }
  interface ZodNumber extends ZodType {
    int(): ZodNumber
    positive(): ZodNumber
  }
  export const z: {
    object(shape: Record<string, unknown>): ZodType
    number(): ZodNumber
  }
  export class ZodError extends Error {}
}
