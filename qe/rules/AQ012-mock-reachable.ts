/**
 * AQ012 · 残留族：mock / seed / fixture 数据在生产源码里可达。
 *
 * ## 事故形态
 *
 * AI 分模块开发时，为了让页面「先跑起来」，最省力的路径是 `import items from '@/mocks/items'`。
 * 后来接口接上了，页面也换了，但**那条 import 常常留着**——它不报错、类型也对、
 * 本地看起来一切正常，只是生产环境里多了一份假数据在参与渲染。
 * 更隐蔽的一档是 `await import('./fixtures/catalog')` 藏在 `if (dev)` 里：
 * 门控一改（或构建工具的常量折叠没生效），假数据就跟着上线。
 *
 * ## 判据（只报能证死的那一种）
 *
 * 对射程内的生产源码，解析静态 import / require / 动态 import 的**相对路径**，
 * 路径里带 mock 面标识（`mocks/`、`__mocks__/`、`mock-data`、`fixtures/`、`testdata/`、
 * `demo-data`、`seed(s)/`、`*.mock.*`）即命中：
 *
 * | 形态 | 判定 |
 * |---|---|
 * | 顶层 `import … from './mocks/x'` | 恒可达 → 报 |
 * | `require('./testdata/x.json')` | 恒可达 → 报 |
 * | 块内 `await import('./fixtures/x')` | 前 30 行有 dev 门控（NODE_ENV/isDev/__DEV__）→ 放过，否则报 |
 * | 非相对路径（npm 包） | 不判：包名带 mock 的正当库太多（如测试替身库） |
 * | 本文件自身落在 mock/fixture 目录 | 不判：它是数据本身，不是消费者 |
 *
 * ## 为什么不看「有没有被渲染」
 *
 * 数据流追踪在跨文件时必然漏，而漏掉的假数据正是上线后最难解释的那类。
 * 本条只问一个可以证死的问题：**这段生产代码显式引用了假数据模块吗**。
 * 答是，就有一处需要人确认；答否，才轮到其它判据。
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** mock 面标识：只认路径**段**或文件名，不在长串里找子串 */
const MOCK_SEGMENT = /^(?:__mocks__|mocks?|mock[-_]?data|mockdata|fixtures?|testdata|demo[-_]?data|seeds?|fakes?)$/i
const MOCK_FILENAME = /(?:^|[.\-_])mock(?:[.\-_]|$)/i

/** 非生产文件：测试、样本、以及 mock 面自身 */
const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|fixtures?|__mocks__|mocks?|testdata|e2e)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

/** dev 门控：出现在动态 import 之前 30 行内即视为已挡 */
const DEV_GATE = /(?:NODE_ENV\s*(?:===?|!==?)\s*['"]development['"]|isDev\b|__DEV__|process\.env\.NODE_ENV\s*!==?\s*['"]production['"])/i

/** 静态 import / 动态 import / require 的字符串实参 */
const IMPORT_SPECS: Array<{ re: RegExp; dynamic: boolean }> = [
  { re: /(?:^|[\s;])(?:import|export)[\s\S]{0,400}?\bfrom\s*(['"])([^'"]+)\1/g, dynamic: false },
  { re: /^\s*import\s*(['"])([^'"]+)\1/gm, dynamic: false },
  { re: /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, dynamic: true },
  { re: /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, dynamic: true },
]

function isMockSpec(spec: string): boolean {
  const clean = spec.split('?')[0].replace(/\/+$/, '')
  const parts = clean.split('/')
  const file = parts[parts.length - 1] ?? ''
  if (parts.some((p) => MOCK_SEGMENT.test(p))) return true
  return MOCK_FILENAME.test(file)
}

export const aq12 = toGuard({
  id: 'aq12',
  title: '残留：生产源码引用 mock / seed / fixture 数据',
  invariants: ['INV-RES-01'],
  code: 'AQ012_MOCK_REACHABLE',
  blindSpots: [
    '只看**相对路径**字面量：npm 包名带 mock 的正当依赖、tsconfig 别名（`@/mocks/x`）不在射程',
    '路径由变量拼接、或经 barrel 再导出（`export * from "./mocks"`）时不可见',
    '动态 import 的 dev 门控只认前 30 行内的 NODE_ENV/isDev/__DEV__ 字面量；由构建常量折叠、define 插件、运行时开关引入的门控不可见',
    '不判「假数据是否真的进入渲染」：本条只问「生产代码有没有显式引用假数据模块」',
    '文件自身的目录名带 mock/fixture 时整文件跳过（它是数据本身，不是消费者）',
  ],
  impact:
    '生产源码直接引用假数据模块：不报错、类型也对，本地看起来一切正常，只是线上多了一份假数据参与渲染。' +
    '这类残留不会自己消失——接口接上之后那条 import 通常没人记得删',
  provenance:
    '试点 B（2026-10）：页面先接 mock 数据上线演示，接口接通后 import 未删；线上详情页长期展示三条示例数据，无人察觉，直到对账时发现「有数据的记录」与「接口返回」对不上',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (NON_PROD.test(rel) || TEST_FILENAME.test(rel)) return false
    const self = rel.split('/')
    const base = self[self.length - 1] ?? ''
    if (self.some((p) => MOCK_SEGMENT.test(p)) || MOCK_FILENAME.test(base.replace(/\.\w+$/, ''))) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []
    const seen = new Set<number>()
    for (const { re, dynamic } of IMPORT_SPECS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(code)) !== null) {
        const spec = m[2]
        if (!spec || !spec.startsWith('.')) continue
        if (!isMockSpec(spec)) continue
        const index = m.index
        if (seen.has(index)) continue
        if (dynamic) {
          const before = code.slice(Math.max(0, index - 30 * 120), index)
          const window = before.split('\n').slice(-30).join('\n')
          if (DEV_GATE.test(window)) continue
        }
        seen.add(index)
        const kind = dynamic ? '动态导入/require' : '顶层 import'
        hits.push({
          line: lineOf(src, index),
          message:
            `${kind} 引用了假数据模块 \`${spec}\`：生产环境会一起打包/加载。` +
            '删掉这条引用，或把它放进显式的 dev 门控里（并在门控内侧保留注释说明用途）',
          evidence: evidenceOf(src, index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '顶层 import 假数据（该报）',
      expect: 'red',
      rel: 'src/app/items/page.tsx',
      src: "import { items } from '../../mocks/items'\nexport default function Page() { return null }\n",
    },
    {
      name: 'require 测试数据（该报）：JSON 假数据同样进包',
      expect: 'red',
      rel: 'src/lib/report.ts',
      src: "const rows = require('../../testdata/records.json')\nexport const total = rows.length\n",
    },
    {
      name: '无门控的动态 import fixtures（该报）',
      expect: 'red',
      rel: 'src/app/entries/page.tsx',
      src: "export async function load() { return (await import('../fixtures/entries')).items }\n",
    },
    {
      name: 'dev 门控内的动态 import（不该报）：门控就在前 30 行内',
      expect: 'green',
      rel: 'src/app/entries/page.tsx',
      src:
        "export async function load() {\n  if (process.env.NODE_ENV === 'development') {\n" +
        "    return (await import('../fixtures/entries')).items\n  }\n  return fetch('/api/entries').then((r) => r.json())\n}\n",
    },
    {
      name: '注释里的 import（不该报）：去注释先于解析',
      expect: 'green',
      rel: 'src/app/page.tsx',
      src: "// 旧写法：import items from '../mocks/items'\nexport default function Page() { return null }\n",
    },
    {
      name: '测试文件自己引用 mock（不该报）：测试面不在射程',
      expect: 'green',
      files: {
        'src/mocks/__tests__/items.test.ts': "import { items } from '../items'\nexport const ok = items.length > 0\n",
        // 样本根必须留一个射程内文件，否则「0 个文件」会让样本以 NotApplicable 失败
        'src/app/page.tsx': 'export default function Page() { return null }\n',
      },
    },
    {
      name: 'mock 数据文件自身（不该报）：它是数据本身，不是消费者',
      expect: 'green',
      files: {
        'src/mocks/items.ts': "import { asset } from '../fixtures/assets'\nexport const items = [asset]\n",
        'src/app/page.tsx': 'export default function Page() { return null }\n',
      },
    },
    {
      name: 'npm 包名带 mock（不该报）：非相对路径不判',
      expect: 'green',
      rel: 'src/lib/tracking.ts',
      src: "import { mock } from 'mock-proxy'\nexport const client = mock\n",
    },
  ],
})
