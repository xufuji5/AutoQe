/**
 * AQ007 · 假绿锚点（判据自己失效）
 *
 * ## 这是元判据：它找的不是业务 bug，是「守卫病的 bug」
 *
 * 一个仓库最危险的状态不是红，是**绿得没有意义**。以下写法会让判据恒真，
 * 而它们全部长得像正常代码：
 *
 * | 反模式 | 为什么恒真 |
 * |---|---|
 * | `assert('x', true)` | 常量真 —— 本来想写变量，手滑或占位忘删 |
 * | `assert('x', 'false')` | 非空字符串恒真（这是最阴的一种：看起来像有判定） |
 * | `cond \|\| true` | 短路兜底，条件永远成立 |
 * | `expect(n).toBeGreaterThanOrEqual(0)` | 计数天然 ≥0，等于没断言 |
 * | `path.startsWith('/admin')` 做权限判定 | 前缀匹配命中 `/admin-evil`，安全边界失效 |
 * | `process.exitCode = 0` 在失败分支之后 | 覆盖掉失败退出码，CI 永远绿 |
 *
 * 前四类在「守卫」出现的那一刻就注定无效；第五类不是恒真，是**边界过宽**，
 * 后果同样是「该红的时候绿」。第六类最贵：它让整条流水线的红全部消失。
 *
 * ## 为什么放在 AutoQe 而不是各项目各写一份
 * 这些形态与业务无关、与语言接近、且**每个项目都会犯**（本项目两个仓库各犯过至少两次）。
 * 它是「跨项目转移性 ✅ 直接搬」那一栏里最该先搬的东西。
 */
import { stripComments, maskStringBodies } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

type Probe = {
  name: string
  re: RegExp
  impact: string
  /**
   * 是否必须在「保留字符串」的代码面上匹配。
   * - `true`：判据要看字符串字面量本身（`assert('x','false')`）；
   * - `false`：只看结构（`if (false)` / `|| true`）——必须在**抹掉字符串内容**的面上匹配，
   *   否则模板字符串里的示例代码（文档里的反模式）会被当真洞。
   *   首轮实测就撞上了：`if (false)` 出现在一段 SQL 模板串里。
   */
  needStrings?: boolean
  /** 可选：命中后二次过滤（返回 false 则丢弃） */
  keep?: (line: string, m: RegExpExecArray) => boolean
}

const PROBES: Probe[] = [
  {
    name: '常量真断言',
    needStrings: true,
    // assert(<name>, true) / assert(<name>, true, ...)
    re: /\bassert\s*\(\s*[^,)]+,\s*true\s*[,)]/g,
    impact: '断言第二个参数是字面量 true：这条断言恒真，永远不会红',
  },
  {
    name: '字符串当断言条件',
    needStrings: true,
    // assert('x', 'false') —— 非空字符串恒真。
    // 必须要求**第一个参数也是字符串字面量**：有些项目的签名是 assert(cond, message)，
    // 那里的第二个参数天生是字符串（实测误报过一次，把 6 条正确断言写成了恒真）。
    re: /\bassert\s*\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*[,)]/g,
    impact: '断言条件传了字符串字面量：非空字符串恒真（看起来像判定，实际恒过）',
  },
  {
    name: '短路兜底恒真',
    re: /\|\|\s*true\b/g,
    impact: '条件后接 `|| true`：短路后条件永远成立，等于删掉了这条判据',
  },
  {
    name: '计数 ≥ 0 断言',
    // 两种写法：断言库的 toBeGreaterThanOrEqual(0)，和裸 assert(name, x >= 0)
    re: /(?:toBeGreaterThanOrEqual\s*\(\s*0\s*\)|\bassert\s*\(\s*[^,)]+,\s*[A-Za-z_$][\w$.]*\s*>=\s*0\s*\))/g,
    impact: '对计数断言 ≥0：计数天然非负，等于没有断言（应断言精确值或集合相等）',
  },
  {
    name: '前缀匹配当安全边界',
    re: /\.startsWith\s*\(\s*['"][^'"]*['"]\s*\)/g,
    impact: '前缀匹配做边界判定：`/admin` 会命中 `/admin-evil`，该拒绝的请求被放过',
    // 首轮实测教训：只看「同一行出现 path/url」会把 URL 规范化（`.startsWith('/')`）
    // 全算成权限判定，试点 A 上一次报了 76 处、几乎全是误报。
    // 真正的信号是**同一行有权限语义词**，且参数不是一个泛化的分隔符。
    keep: (line) =>
      /\b(allow|allowed|deny|forbidden|authorized|unauthorized|permit|canAccess|isAllowed)\b/i.test(line) &&
      !/\.startsWith\s*\(\s*['"]\/(?:['"])/.test(line),
  },
  {
    name: '覆盖退出码',
    re: /process\.exitCode\s*=\s*0\b/g,
    impact: '显式把退出码置 0：前面判红的失败被覆盖，CI 永远绿',
  },
  {
    name: '恒假分支',
    re: /\bif\s*\(\s*false\s*\)/g,
    impact: '`if (false)` 分支永不执行：要么是关掉判据的残留，要么是死代码',
  },
]

export const aq07 = toGuard({
  id: 'aq07',
  title: '假绿锚点（判据自身恒真/边界过宽）',
  invariants: ['INV-CORE-18'],
  code: 'AQ007_FAKE_GREEN',
  blindSpots: [
      '只认七种已知形态；「逻辑上恒真但写法复杂」不在射程（那需要符号执行）',
      '扫描目标是判据自身：本规则也会扫到自己，故其 fixtures 刻意不放真实断言写法',
      '不判断言是否覆盖了该覆盖的维度（覆盖度是另一条判据的事）',
    ],
  impact: '判据绿得没有意义：本该红的时候全绿，比没有判据更危险（人会相信它）',
  provenance: "外部试点 A 多次「守卫恒真」返工（前缀匹配把 /admin-x 当成 /admin、手数分组漏两条）+ 外部试点 B 的守卫自检",
  applies(rel) {
    if (!/\.(ts|tsx|js|mjs|mts|mjsx?)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    // 自证样本文件里，反模式是**被测对象**（故意写的反例）。跳过它们，否则元判据会
    // 把「测元判据的夹具」当成真洞——第一次跑就撞上了（6 处 assert('a1', true)）。
    // 注意这是**文件名约定**而不是任意豁免：要逃逸就得把真守卫改名成 selftest，代价可见。
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const extra = (ctx.options.extraProbes as Array<{ name: string; pattern: string; impact: string }> | undefined) ?? []
    const probes: Probe[] = [
      ...PROBES,
      ...extra.map((e) => ({ name: e.name, re: new RegExp(e.pattern, 'g'), impact: e.impact })),
    ]
    const code = stripComments(src)
    const masked = maskStringBodies(code)
    const hits: RawHit[] = []
    for (const p of probes) {
      const hay = p.needStrings ? code : masked
      p.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = p.re.exec(hay)) !== null) {
        const at = m.index
        const lineStart = hay.lastIndexOf('\n', at) + 1
        let lineEnd = hay.indexOf('\n', at)
        if (lineEnd === -1) lineEnd = hay.length
        const line = hay.slice(lineStart, lineEnd)
        if (p.keep && !p.keep(line, m)) continue
        hits.push({ line: lineOf(src, at), evidence: evidenceOf(src, at), impact: `${p.name}：${p.impact}` })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '常量真断言（该报）',
      expect: 'red',
      src: `suite.assert('用户能登录', true)\n`,
    },
    {
      name: '字符串当条件（该报）',
      expect: 'red',
      src: `suite.assert('订单已创建', 'false')\n`,
    },
    {
      name: '短路恒真（该报）',
      expect: 'red',
      src: `const ok = check(a) || true\n`,
    },
    {
      name: '计数 >=0（该报）',
      expect: 'red',
      src: `expect(rows.length).toBeGreaterThanOrEqual(0)\n`,
    },
    {
      name: '前缀匹配做权限（该报）',
      expect: 'red',
      src: `const allowed = path.startsWith('/admin')\n`,
    },
    {
      name: '覆盖退出码（该报）',
      expect: 'red',
      src: `if (failed > 0) process.exitCode = 0\n`,
    },
    {
      name: '真变量断言（不该报）',
      expect: 'green',
      src: `suite.assert('用户能登录', res.status === 200)\n`,
    },
    {
      name: '普通 startsWith 取扩展名（不该报）',
      expect: 'green',
      src: `const isImage = name.startsWith('image/')\n`,
    },
    {
      name: '注释里的反模式（不该报）',
      expect: 'green',
      src: `// 旧写法：assert('x', true) 是错的\nconst x = 1\n`,
    },
  ],
})
