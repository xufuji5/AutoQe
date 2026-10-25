/**
 * AQ002 · 状态裸字面量旁路（状态机语义外泄到调用点）
 *
 * ## 为什么这是病
 * 「状态值有没有产生路径」在源码层面不可判定（数引用次数会把常量引用计成零出现）。
 * 可判定的是另一个事实：**源码里有没有绕过单源的状态判定**。
 * 只要允许 `status === 'paid'` 散落在各处，状态机的语义就有 N 份副本：
 * 加一个状态、改一次转移规则，你得 grep 全仓，而漏掉的那一处不会红 —— 它只是行为不同。
 *
 * ## 判据（可机械判定）
 * 1. 从 Prisma schema 的 `enum` 抽出全部状态值（**不猜**：项目没有 enum 就用配置里的
 *    `stateValues`；两者都没有则本规则静默跳过，宁可少报也不瞎报）；
 * 2. 找 `status === '<值>'` / `!==` / `==` 的比较；
 * 3. 排除声明为「状态语义的家」的模块（owner modules）—— 那里的工作就是裸写状态。
 *
 * ## 为什么用 schema 自动提取而不是人工登记
 * 登记制会退化：新增一个状态时没人会记得回来更新登记表，于是新状态永远不被守。
 * schema 是单源，加字段的人必须改它 —— 判据自动跟上。
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf, stateValuesOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const CMP_RE = /\bstatus\s*(?:===|!==|==|!=)\s*['"]([A-Za-z0-9_]+)['"]/g

export const aq02 = toGuard({
  id: 'aq02',
  title: '状态裸字面量旁路（应走谓词/枚举）',
  invariants: ['INV-CORE-04'],
  code: 'AQ002_STATUS_LITERAL',
  // 提示档（info）：裸字面量比较是风格债，不是当批必须修的红项。实测目标仓 .tsx 展示层
  // 之外仍有 214 处，按 warn 计会长期把黄灯钉死，黄灯一常亮就等于没有黄灯。
  level: 'info',
  blindSpots: [
      '只认 `status === 字面量` 形态；`switch(status)`、`includes([...])`、配置表驱动的判断不在射程',
      '状态值来自 schema enum；无 enum 且未配置 `stateValues` 时本规则显式声明未生效（不许报 0 命中）',
      '展示层（`.tsx` 页面）默认不判——那里比较状态只影响显示；确需判时用 `includeUi: true`',
    ],
  impact: '状态语义散落各处，改状态机时漏改的那一处不报错、只是行为不同——静默不一致',
  provenance: "外部试点 A（2026-10）：142 个文件数百处旁路，判据从「零旁路」降级为棘轮计数才活下来；外部试点 B 复跑确认状态值可由 schema 自动提取",
  applies(rel) {
    if (!/\.(ts|tsx|js|mjs|mts)$/.test(rel)) return false
    if (/\.(test|spec)\./.test(rel)) return false
    if (/(^|\/)(prisma|drizzle)\//.test(rel)) return false
    // 首轮外部试跑撞出来的两片噪声（试点 B 的 478 处里约 130 处属这两类）：
    //   ① e2e/seed/探针脚本：它们是**制造**状态的地方，本来就该写裸字面量；
    //   ② 展示层（.tsx）：`status === 'DONE' && '已完成'` 是渲染，不是转移判定。
    // 两类都不是本规则射程（本规则问的是「改转移规则要 grep 多少处」）。
    // 展示层可用 `options.includeUi: true` 拉回来 —— 但默认不拉，噪声会淹掉真洞。
    if (/(^|\/)(e2e|__tests__|fixtures|mocks|seeds?)[\w.-]*/.test(rel)) return false
    return true
  },
  /**
   * 前置条件：找不到状态值来源时**必须声明退出**，不许静默返回空。
   * 外部试点 A 上没有 prisma enum，本规则曾报「0 处」—— 那个 0 是「没检查」，不是「没洞」。
   */
  notApplicable(ctx) {
    if (stateValuesOf(ctx).size === 0) {
      return {
        code: 'STATE_VALUES_UNSET',
        reason: '找不到状态值来源：项目无 prisma enum 且未配 stateValues（本轮未检查，0 命中≠无缺陷）',
      }
    }
    return null
  },
  analyze(src, rel, ctx): RawHit[] {
    const owners = (ctx.options.ownerModules ?? []) as string[]
    if (owners.includes(rel)) return []
    const includeUi = ctx.options.includeUi === true
    if (!includeUi && /\.tsx$/.test(rel)) return []

    const stateValues = stateValuesOf(ctx)
    if (stateValues.size === 0) return []

    const code = stripComments(src)
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    CMP_RE.lastIndex = 0
    while ((m = CMP_RE.exec(code)) !== null) {
      const v = m[1]
      if (!stateValues.has(v)) continue
      // 全大写 + 下划线以外的小写值也接受（enum 值可能小写），这里只做大小写无关命中
      const at = m.index
      hits.push({
        line: lineOf(src, at),
        evidence: evidenceOf(src, at),
        impact: `状态值 '${v}' 被裸字面量比较：应改用谓词函数或枚举常量，否则状态机有第二份副本`,
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '裸字面量比较（该报）',
      expect: 'info',
      options: { stateValues: ['PAID'] },
      src: `if (order.status === 'PAID') { ship() }\n`,
    },
    {
      name: '谓词函数（不该报）',
      expect: 'green',
      options: { stateValues: ['PAID'] },
      src: `if (isPaid(order)) { ship() }\n`,
    },
    {
      name: '枚举常量（不该报）',
      expect: 'green',
      options: { stateValues: ['PAID'] },
      src: `if (order.status === ORDER_STATUS.PAID) { ship() }\n`,
    },
    {
      name: '非状态字段的字面量（不该报）',
      expect: 'green',
      options: { stateValues: ['PAID'] },
      src: `if (user.role === 'PAID') { x() }\n`,
    },
    {
      name: 'e2e 脚本里的裸比较（不该报，配一个射程内文件保证非空射程）',
      expect: 'green',
      options: { stateValues: ['PAID'] },
      files: {
        'scripts/e2e-m03.mjs': `if (res.status === 'PAID') { log('ok') }\n`,
        'src/lib/format.ts': `export const money = (n: number) => n.toFixed(2)\n`,
      },
    },
    {
      name: '展示层渲染 status（默认不该报，配一个射程内文件保证非空射程）',
      expect: 'green',
      options: { stateValues: ['DONE'] },
      files: {
        'app/(workbench)/records/page.tsx': `const cls = o.status === 'DONE' ? 'ok' : 'wait'\n`,
        'src/lib/format.ts': `export const money = (n: number) => n.toFixed(2)\n`,
      },
    },
    {
      name: '展示层开启 includeUi 后该报',
      expect: 'info',
      options: { stateValues: ['DONE'], includeUi: true },
      rel: 'app/(workbench)/records/page.tsx',
      src: `const cls = o.status === 'DONE' ? 'ok' : 'wait'\n`,
    },
    {
      name: '注释里的比较（不该报）',
      expect: 'green',
      options: { stateValues: ['DONE'] },
      src: `// 旧写法：if (record.status === 'DONE')\nconst x = 1\n`,
    },
  ],
})
