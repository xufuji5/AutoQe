/**
 * 并发探针标配工具：≥8 路同 tick 放行 + 反证断言。
 *
 * 抽取自 试点 A `scripts/lib/concurrency-probe.ts`。
 *
 * ## 为什么需要它
 * 三轮 probe 最有价值的发现是一句备注：「2 路并发恰好串行，只放行 1 次」。
 * 意思是 `Promise.all([a, b])` 看起来并发，实际两个请求可能被连接池/事件循环错峰处理，
 * 竞争窗口根本撞不上 —— **按 2 路跑一辈子都是绿的**。
 *
 * 本模块做两件事：
 *   ① **屏障放行**：N 个执行体先全部停在同一个 gate 上（同步停在第一个 await），再一起放行，
 *      使它们的首个 IO 落在同一个事件循环 tick —— 这才叫「同时」，不是「先后发出」；
 *   ② **轮次**：单轮可能因抖动侥幸串行（正好掩盖洞），`rounds` 连打多轮，任一轮撞出双执行即失败。
 *
 * ## 纪律
 * - 只断言「恰好一个赢家」还不够，必须配**反证**（顺序第二次必须失败；或单路必须成功），
 *   否则「实现返 false」也能让断言变绿 —— 这是最常见的假绿；
 * - 探针必须能对旧实现判红：新写探针先用旧实现跑一遍，红了才算有效（注入反证）。
 */

export interface ConcurrentRun<T> {
  values: T[]
  errors: unknown[]
  ok: number
  total: number
}

/**
 * 屏障式并发执行：n 个执行体同 tick 放行，重复 rounds 轮。
 *
 * @param n     并发路数（资金/额度/计数类 ≥8；只读类可降）
 * @param fn    单个执行体，入参是 0..n-1 的路号
 * @param opts  rounds=轮次（默认 1）
 */
export async function runConcurrent<T>(
  n: number,
  fn: (i: number) => Promise<T>,
  opts: { rounds?: number } = {},
): Promise<ConcurrentRun<T>> {
  const rounds = Math.max(1, opts.rounds ?? 1)
  const values: T[] = []
  const errors: unknown[] = []

  for (let round = 0; round < rounds; round++) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    // 关键：async IIFE 会同步执行到第一个 await（即 gate），
    // 故 Array.from 结束时 n 个执行体已全部停在 barrier 上，release() 后同 tick 齐发。
    const tasks = Array.from({ length: n }, (_, i) =>
      (async () => {
        await gate
        return fn(i)
      })(),
    )

    release()
    const settled = await Promise.allSettled(tasks)
    for (const s of settled) {
      if (s.status === 'fulfilled') values.push(s.value)
      else errors.push(s.reason)
    }
  }

  return { values, errors, ok: values.length, total: n * rounds }
}

/** 真值计数（boolean 结果集里 True 的个数）—— 配「恰好一次」断言用 */
export function winners(values: readonly unknown[]): number {
  return values.filter(Boolean).length
}

/** 断言辅助文案：把并发结果压成一行，失败时能直接看出「几个赢家/几个异常」 */
export function describeRun<T>(run: ConcurrentRun<T>): string {
  const first = run.errors[0]
  return (
    `ok=${run.ok}/${run.total} errors=${run.errors.length}` +
    (first ? ` firstError=${first instanceof Error ? first.message : String(first)}` : '')
  )
}

/**
 * 「恰好一次」的完整判据（含反证），避免每个探针各写一遍。
 *
 * 返回结构化结论而不是直接 assert：调用方自己决定进哪个 suite 分组。
 */
export async function probeExactlyOnce<T>(opts: {
  n: number
  rounds?: number
  run: (i: number) => Promise<T>
  /** 反证：顺序执行第一次必须成功、第二次必须失败。省略则该结论只能算半条判据 */
  sequentialTwice?: () => Promise<{ first: unknown; second: unknown }>
}): Promise<{ winners: number; total: number; exactlyOne: boolean; counterProofOk: boolean | null; detail: string }> {
  const r = await runConcurrent(opts.n, opts.run, { rounds: opts.rounds })
  const w = winners(r.values)
  let counterProofOk: boolean | null = null
  if (opts.sequentialTwice) {
    const seq = await opts.sequentialTwice()
    counterProofOk = Boolean(seq.first) && !seq.second
  }
  return {
    winners: w,
    total: r.total,
    exactlyOne: w === 1 && r.errors.length === 0,
    counterProofOk,
    detail: `${describeRun(r)} winners=${w}`,
  }
}
