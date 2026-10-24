/**
 * 外部依赖故障注入器（行为腿）：替换 globalThis.fetch，不改一行业务代码。
 *
 * 抽取自一处生产仓的 `scripts/lib/fault-inject.ts`。
 *
 * ## 为什么静态判据不够
 * 「catch 里有没有人管」回答的是代码形态，不是「故障真发生时那个动作执行了吗、语义对吗」。
 * 两者的差距可归成四种假降级：
 *   ① 不可达：catch 写了，但更早的地方就抛了 / 错误类型不匹配 / 上层超时先到；
 *   ② 语义错：fallback 值被下游误读（「查不到」被读成「没有」）；
 *   ③ 无界：SDK 隐式重试 × 外层重试 = 实际等待远超调用方预算；
 *   ④ 静默：降级动作是控制面写（刷节流锚、置本地变量），不是业务补偿，越降级越安静。
 * 这四条都**读不出来**，只能打断一次看。
 *
 * ## 安全约束（不能松）
 * 生产 `.env` 里的第三方凭据是真的。若注入器漏放一个 host，测试就会真写一个对象、
 * 真扣一次配额、真花一次模型费。所以默认 `strict`：**未匹配任何规则的出站请求一律抛错**，
 * 把「零真实出站」变成机制保证，而不是「我记得都 mock 了」。
 *
 * ## 用法
 * ```ts
 * const inj = installFaults([{ host: 'storage.example.com', mode: 'http5xx', status: 503 }])
 * try { await putBuffer(...) } finally { inj.restore() }
 * assert('无意外出站', inj.unexpected.length === 0)
 * ```
 */

export type FaultMode =
  | 'refused'
  | 'reset'
  | 'timeout'
  | 'http5xx'
  | 'badjson'
  | 'bizfail'
  | 'hang'

export interface FaultRule {
  host: string | RegExp
  mode: FaultMode
  status?: number
  body?: string
  errcode?: number
  errmsg?: string
  /** timeout 模式「多久之后报超时」，默认 80ms。测的是降级形态，不是等生产的 30s */
  timeoutMs?: number
  /** 断言期望：该规则**必须**被命中至少一次（否则测的是空气） */
  expectHits?: number
}

export interface FaultCall {
  url: string
  host: string
  method: string
  mode: FaultMode | 'pass'
  /** 生产代码是否给这次调用带了 AbortSignal（超时硬上限存在性的静态证据） */
  hadSignal: boolean
}

interface FetchLike {
  (input: unknown, init?: unknown): Promise<Response>
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const u = (input as { url?: unknown }).url
    if (typeof u === 'string') return u
  }
  try {
    return String(input)
  } catch {
    return '<unstringifiable>'
  }
}

function methodOf(input: unknown, init: unknown): string {
  const m = (init as { method?: unknown } | undefined)?.method
  if (typeof m === 'string') return m.toUpperCase()
  const rm = (input as { method?: unknown } | undefined)?.method
  if (typeof rm === 'string') return rm.toUpperCase()
  return 'GET'
}

function matches(rule: FaultRule, url: string): boolean {
  if (typeof rule.host === 'string') return url.includes(rule.host)
  return rule.host.test(url)
}

/** 未匹配规则时的错误：明确说「注入器拒绝出站」，避免被误读成依赖本身的故障 */
export class FaultInjectorBlocked extends Error {
  readonly url: string
  constructor(url: string) {
    super(
      `[fault-inject] 未声明规则的出站请求被拦截：${url}。` +
        `若这是被测依赖，请在规则里显式声明；若是测试自身的意外请求，说明探针边界没圈干净。`,
    )
    this.url = url
    this.name = 'FaultInjectorBlocked'
  }
}

export interface Injector {
  calls: FaultCall[]
  /** 未声明规则而被拦截的 URL（必须为空，否则「零真实出站」不成立） */
  unexpected: string[]
  hitCount(): Record<string, number>
  verifyExpectations(): { ok: boolean; detail: Array<{ host: string; want: number; got: number }> }
  restore(): void
}

export function installFaults(rules: FaultRule[], opts: { strict?: boolean } = {}): Injector {
  const strict = opts.strict !== false
  const g = globalThis as unknown as { fetch: FetchLike }
  const original = g.fetch
  const calls: FaultCall[] = []
  const unexpected: string[] = []

  const mock: FetchLike = async (input: unknown, init?: unknown) => {
    const url = urlOf(input)
    let host = ''
    try {
      host = new URL(url).host
    } catch {
      host = url
    }
    const method = methodOf(input, init)
    const hadSignal = Boolean((init as { signal?: unknown } | undefined)?.signal)
    const rule = rules.find((r) => matches(r, url))

    if (!rule) {
      calls.push({ url, host, method, mode: 'pass', hadSignal })
      if (strict) {
        unexpected.push(url)
        throw new FaultInjectorBlocked(url)
      }
      return original(input, init)
    }

    calls.push({ url, host, method, mode: rule.mode, hadSignal })

    switch (rule.mode) {
      case 'refused':
        throw new TypeError('fetch failed')
      case 'reset':
        throw new TypeError('terminated')
      case 'timeout': {
        await new Promise((r) => setTimeout(r, rule.timeoutMs ?? 80))
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
          code: 'ETIMEDOUT',
        })
      }
      case 'hang': {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal
        return await new Promise<Response>((_, reject) => {
          if (!signal) return // 无 signal ⇒ 永不 settle，进程挂到结束——那本身就是判据
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      case 'http5xx': {
        const status = rule.status ?? 503
        return new Response(rule.body ?? `<html><body>${status} Service Unavailable</body></html>`, {
          status,
          headers: { 'content-type': 'text/html' },
        })
      }
      case 'badjson':
        return new Response(rule.body ?? '<html><head><title>502 Bad Gateway</title></head></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      case 'bizfail': {
        const payload =
          rule.body ??
          JSON.stringify({ errcode: rule.errcode ?? 40001, errmsg: rule.errmsg ?? 'invalid credential' })
        return new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
  }

  g.fetch = mock

  return {
    calls,
    unexpected,
    hitCount() {
      const out: Record<string, number> = {}
      for (const c of calls) {
        if (c.mode === 'pass') continue
        out[c.host] = (out[c.host] ?? 0) + 1
      }
      return out
    },
    verifyExpectations() {
      const detail = rules.map((r) => {
        const got = calls.filter(
          (c) => c.mode !== 'pass' && (typeof r.host === 'string' ? c.url.includes(r.host) : r.host.test(c.url)),
        ).length
        return { host: String(r.host), want: r.expectHits ?? 1, got }
      })
      return { ok: detail.every((d) => d.got >= d.want), detail }
    },
    restore() {
      g.fetch = original
    },
  }
}
