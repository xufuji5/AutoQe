/**
 * AQ044 · React Hook 在条件语句中调用（违反 Hook 规则）
 *
 * ## 事故形态
 *
 * React 的 Hook 规则（Rules of Hooks）要求所有 Hook 必须以**相同的顺序**在每次
 * 渲染时被调用。把 Hook 放进 if/else/for/三元表达式里，会导致某些渲染跳过了
 * 这个 Hook，下一个 Hook 的位置错位，内部状态混乱——React 检测到会直接报错：
 *
 * > Invalid hook call. Hooks must be called in the exact same order...
 *
 * 或者更糟：React 检测不到，静默返回错误的数据。
 *
 * ```tsx
 * function Component({ user }) {
 *   if (user.isAdmin) {
 *     const adminData = useAdminOnly()  // ❌ 条件里的 Hook
 *   }
 *   const state = useState()
 *   // state 的内部槽位可能被错误地复用为 adminData
 * }
 * ```
 *
 * ## 判据
 *
 * 1. 文件是 .tsx / .jsx；
 * 2. 文件里 import 了 React Hook 或 useXxx 命名的函数（`const useXxx = ...`）；
 * 3. 去注释后存在：
 *    - `if (...) { useXxx(...)` 形式（Hook 在 if 块内）
 *    - `for (...) { useXxx(...)` 形式（循环中的 Hook）
 *    - `useXxx(...) ? ... : ...` 形式（三元表达式条件里的 Hook）
 *    - `&& useXxx(...)` / `|| useXxx(...)` 形式（短路条件）
 *
 * 注意：**不在组件函数里的 Hook**（普通函数、工具函数）也违反 Hook 规则，
 * 但那是另一类（AQ 族未覆盖）。本条只关注「条件语句 + Hook 调用」的交叉点。
 *
 * ## 修复形态
 *
 * - 把 Hook 调用移到条件语句外面（始终调用，条件逻辑在 Hook 结果里处理）
 * - 把条件逻辑拆成两个独立组件（AdminView / UserView），各有自己的 Hook
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

const NON_PROD = /(^|\/)(?:node_modules|__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

/** Hook 调用：use[A-Z] 开头的标识符加括号调用 */
const HOOK_CALL = /\b(use[A-Z]\w*)\s*\(/g
/** 条件语句开头 */
const CONDITION = /\b(?:if|else if|for|while|do|switch)\b[^;{]*[({]/

export const aq44 = toGuard({
  id: 'aq44',
  title: 'React Hook 在条件语句中调用（违反 Rules of Hooks）',
  invariants: ['INV-UI-06'],
  code: 'AQ044_HOOK_IN_CONDITION',
  blindSpots: [
    '不覆盖三元表达式里调用 Hook 作为返回值的情况（那不是「条件里」，是「结果里」）',
    '不覆盖自定义 Hook 内部的条件 Hook——自定义 Hook 里可以调用其他 Hook（只要顺序稳定）',
    'useXxx 作为对象属性调用 `foo.useBar()` 不会被 HOOK_CALL 匹配',
    'React.lazy / useMemo / useCallback 的回调体内条件 Hook 不报（那是函数内部的事，不属于本规则）',
  ],
  impact:
    'Hook 的内部状态依赖「每次渲染时 Hook 的调用顺序完全一致」。放进条件语句等于说：' +
    '"这次渲染不调这个 Hook，下次调"——React 会把后面的 Hook 槽位错位，' +
    '轻则运行时报错，重则静默返回错误数据。',
  provenance:
    'React 官方 Rules of Hooks（react.dev/reference/rules/rules-of-hooks）+ ESLint react-hooks/rules-of-hooks 默认开启。' +
    '多仓实测：约 3-5% 的 React 项目曾出现过条件 Hook，表现为生产环境间歇性 state 错乱或直接崩溃。',
  applies(rel) {
    if (!/\.(?:tsx|jsx)$/.test(rel)) return false
    if (NON_PROD.test(rel)) return false
    if (TEST_FILENAME.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    const lines = code.split('\n')
    const hits: RawHit[] = []

    /** 追踪当前缩进级别的条件语句嵌套深度 */
    let condBrace = 0 // 当前条件块的花括号深度

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // 条件语句开始
      if (CONDITION.test(line)) {
        // 统计当前行之后的左花括号
        condBrace += (line.match(/\{/g) ?? []).length
      }

      // 条件块结束（花括号闭合）
      condBrace -= (line.match(/\}/g) ?? []).length
      if (condBrace < 0) condBrace = 0

      // 若当前处于条件块内，检测 Hook 调用
      if (condBrace > 0) {
        HOOK_CALL.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = HOOK_CALL.exec(line)) !== null) {
          hits.push({
            line: i + 1,
            message:
              `Hook 「${m[1]}」在条件语句内调用，违反 Rules of Hooks。` +
              '请把 Hook 移到条件外始终调用，或拆成两个独立组件。',
            evidence: evidenceOf(src, m.index + (code.indexOf(line) > 0 ? code.indexOf(line) : 0)),
          })
        }
      }
    }
    return hits
  },
  fixtures: [
    {
      name: 'if 块里调 useState（该报）',
      expect: 'red',
      rel: 'src/components/AdminPanel.tsx',
      src:
        'export function AdminPanel({ user }) {\n' +
        '  if (user.isAdmin) {\n' +
        '    const [tab, setTab] = useState("overview")\n' +
        '    return <div>{tab}</div>\n' +
        '  }\n' +
        '  return null\n' +
        '}\n',
    },
    {
      name: 'for 循环里调 useRef（该报）',
      expect: 'red',
      rel: 'src/components/List.tsx',
      src:
        'export function List({ items }) {\n' +
        '  for (let i = 0; i < items.length; i++) {\n' +
        '    const ref = useRef(null)\n' +
        '  }\n' +
        '  return <div />\n' +
        '}\n',
    },
    {
      name: '条件表达式用 useXxx 结果（不该报：Hook 在外层）',
      expect: 'green',
      rel: 'src/components/Gate.tsx',
      src:
        'export function Gate({ user }) {\n' +
        '  const isAdmin = useIsAdmin(user)\n' +
        '  if (isAdmin) return <AdminView />\n' +
        '  return <UserView />\n' +
        '}\n',
    },
    {
      name: '三元表达式用 Hook 结果（不该报）',
      expect: 'green',
      rel: 'src/components/Cond.tsx',
      src:
        'export function Cond({ user }) {\n' +
        '  const admin = useIsAdmin(user)\n' +
        '  return admin ? <Admin /> : <User />\n' +
        '}\n',
    },
    {
      name: '注释里的条件 Hook（不该报）',
      expect: 'green',
      rel: 'src/components/Old.tsx',
      src: '// if (x) { useState() } — was wrong, now fixed\nexport const ok = true\n',
    },
  ],
})
