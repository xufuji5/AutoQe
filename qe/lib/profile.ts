/**
 * 阶段计时（`QE_PROFILE=1`）。
 *
 * 为什么需要它：优化必须先看分布。没有分段读数，「换解析器 / 换编译器」都只能凭感觉，
 * 而实测常常是另一回事（本仓 2026-10-25：AST 解析 0.2s，typecheck 5.8s）。
 *
 * 默认关闭时只多一次布尔判断：不打印、不改变任何读数与退出码。
 */
const ENABLED = process.env.QE_PROFILE === '1'

interface Stage {
  name: string
  ms: number
  meta?: Record<string, number>
}

const stages: Stage[] = []

export function profileEnabled(): boolean {
  return ENABLED
}

export function recordStage(name: string, ms: number, meta?: Record<string, number>): void {
  if (!ENABLED) return
  stages.push({ name, ms, meta })
}

/** 包住一个异步阶段；关闭时直接透传，不产生额外行为 */
export async function timeStage<T>(name: string, fn: () => Promise<T>, meta?: Record<string, number>): Promise<T> {
  if (!ENABLED) return fn()
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    recordStage(name, performance.now() - t0, meta)
  }
}

/** 命令结束时按登记顺序输出；机器读数以 `QE_PROFILE ` 开头，便于 grep */
export function flushProfile(): void {
  if (!ENABLED) return
  for (const s of stages) {
    const meta = s.meta ? Object.entries(s.meta).map(([k, v]) => ` ${k}=${v}`).join('') : ''
    console.log(`QE_PROFILE stage=${s.name} ms=${s.ms.toFixed(1)}${meta}`)
  }
}
