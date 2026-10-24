/**
 * AQ001 · 请求体解析未兜底（裸 `request.json()`）
 *
 * ## 真实事故形态
 * 客户端发来畸形 JSON（或 content-type 不是 json）时，`await request.json()` 直接抛
 * SyntaxError。若没人接，Next 返回 500 + 堆栈页。表现是「偶发 500」，日志里只有
 * `Unexpected token`，无法归因到具体接口 —— 因为 500 是框架给的，不是业务给的。
 *
 * ## 判据
 * 找到 `request.json()` / `req.json()` / `request.text()` 的调用点，判断它是否：
 *   - 在 `try { ... } catch` 体内（就近向上找到未闭合的 try 块）；
 *   - 或紧跟 `.catch(`；
 *   - 或在同名文件里被一层 helper 包裹（`parseJson` 之类）——这种情况根本不会出现裸调用，
 *     自然不命中。
 *
 * ## 误报边界（这是本规则唯一难的地方）
 * 协议自有的端点（JSON-RPC、某些 webhook 回调）**必须**返回协议规定的错误体，
 * 不能换成项目统一的 apiError。这类端点按文件显式声明为 `protocolOwned`，双向校验：
 * 声明了但代码已不是该形态 → 由引擎报 `exempt-drift`，逼人删声明。
 */
import { maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'

/**
 * ## 首轮外部试跑撞出来的误报（必须记下来，否则下个项目重犯）
 * 外部试点 B 上本规则报的第一批 5 处全部是**字符串里的伪调用**：
 *   - `"…禁裸 req.json() 透传…"`（不变量登记表的说明文字）
 *   - `` `B4 裸 req.json() 站点 ${n} ≤ 上限` ``（判据自己的报错模板）
 * 静态判据如果不先屏蔽字符串内容，就会把「描述这个洞的文字」当成洞本身 ——
 * 与被判对象完全不同的一件事，而读数上看起来一模一样。
 * 形态断言：屏蔽后必须一条不剩（fixture：字符串里的伪调用 → miss）。
 */
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

/** 从 index 向前判断是否处在某个 try 块内（未闭合） */
function insideTry(code: string, index: number): boolean {
  // 正向扫到 index，维护「{ 的栈」，栈元素记录该 { 是否由 try 引入
  const stack: boolean[] = []
  for (let i = 0; i < index && i < code.length; i++) {
    const c = code[i]
    if (c === '{') {
      // 往回看 40 个字符里是否有 try（容忍 `try {` / `try\n{`）
      const back = code.slice(Math.max(0, i - 40), i)
      stack.push(/\btry\s*$/.test(back.replace(/\)\s*$/, '')) || /\btry\s*\{?\s*$/.test(back))
    } else if (c === '}') {
      stack.pop()
    }
  }
  return stack.some(Boolean)
}

const CALL_RE = /\b(?:request|req)\.(json|text|formData)\s*\(/g

export const aq01 = toGuard({
  id: 'aq01',
  title: '请求体解析未兜底（裸 request.json）',
  invariants: ['INV-WEB-05'],
  code: 'AQ001_BARE_BODY',
  blindSpots: [
      '只认 `request.json()` / `.text()` / `.formData()` 直接出现在 handler 与 helper 里；经封装的中间件读取不可见',
      '判据是文本级：解析调用被包进三元表达式、`Promise.all`、回调时可能漏判',
      '协议自有端点（JSON-RPC、签名 webhook）必须显式声明豁免，声明后不再校验其错误体是否真的符合协议',
    ],
  impact: '畸形请求体直接冒成 500，客户端拿到堆栈页；日志无法归因到具体接口',
  provenance: "外部试点 A（2026-10）全仓盘点：25 处未走统一解析助手的裸解析，其中 11 处完全无兜底；外部试点 B（2026-10）复跑为 0 真命中",
  applies(rel) {
    return /\.(ts|tsx|js|mjs|mts)$/.test(rel) && !/\.(test|spec)\./.test(rel)
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const owned = (ctx.options.protocolOwned ?? {}) as Record<string, string>
    if (Object.hasOwn(owned, rel)) return []

    const code = maskStringBodies(stripComments(src))
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    CALL_RE.lastIndex = 0
    while ((m = CALL_RE.exec(code)) !== null) {
      const at = m.index
      const lineEnd = code.indexOf('\n', at)
      const tail = code.slice(at, lineEnd === -1 ? code.length : lineEnd)
      if (/\.catch\s*\(/.test(tail)) continue
      if (insideTry(code, at)) continue
      hits.push({
        line: lineOf(src, at),
        evidence: evidenceOf(src, at),
        impact: `裸 await ${m[0]} 未包 try/catch：畸形体或错误 content-type 会冒成 500`,
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '字符串里描述出的 req.json()（不该报）',
      expect: 'green',
      src: 'const msg = "禁裸 req.json() 透传"\nconst n = 1\n',
    },
    {
      name: '模板串里的报错文案带 req.json()（不该报）',
      expect: 'green',
      src: 'check(`裸 request.json() 站点 ${n} <= 上限`, n <= 3)\n',
    },
    {
      name: '裸解析（该报）',
      expect: 'red',
      src: `export async function POST(request: Request) {
  const body = await request.json()
  return Response.json({ ok: body.id })
}
`,
    },
    {
      name: 'try 包裹（不该报）',
      expect: 'green',
      src: `export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'BAD_JSON' }, { status: 400 })
  }
  return Response.json({ ok: true })
}
`,
    },
    {
      name: '.catch 兜底（不该报）',
      expect: 'green',
      src: `const body = await request.json().catch(() => null)\n`,
    },
    {
      name: 'helper 内解析（不该报）',
      expect: 'green',
      src: `export async function parseJsonObject(request: Request) {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false as const }
  }
}
`,
    },
    {
      name: '注释里的裸解析（不该报）',
      expect: 'green',
      src: `// 旧实现：const body = await request.json()\nexport const x = 1\n`,
    },
    {
      name: '协议自有端点声明豁免（不该报）',
      expect: 'green',
      rel: 'app/api/mcp/route.ts',
      options: { protocolOwned: { 'app/api/mcp/route.ts': 'JSON-RPC' } },
      src: `export async function POST(request: Request) {\n  const body = await request.json()\n  return Response.json({ jsonrpc: '2.0' })\n}\n`,
    },
  ],
})
