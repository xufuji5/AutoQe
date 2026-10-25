/**
 * AQ013 · 残留族：页面内的写死数组被当成数据源渲染。
 *
 * ## 事故形态
 *
 * 「先把列表画出来」最快的一步是在页面里写 `const products = [{...}, {...}, {...}]`，
 * 配一个 `.map()`。接口接通后，取数代码加上了，但**那份常量没删**——
 * 于是线上出现两种数据：接口返回的和写死的。用户看到的是写死那份，
 * 对账看到的是接口那份，两边永远对不上。
 *
 * ## 为什么这一条只能出候选（human oracle）
 *
 * 「这段数组是占位数据，还是合法常量」在源码里长得一样：
 * 筛选项、状态显示名、模板骨架、演示开关、导航表，都可能写成结构相同的对象数组并被 `.map()` 渲染。
 * 机器只能证明「存在一个被渲染的写死对象数组，且本文件没有任何取数入口」——
 * **该不该保留**由人按「这个页面是否已有真实数据来源」裁决。
 * 因此本条固定 `level: 'warn'`，不允许升级成 error（由 `rule-oracles` 的导入期硬门执行）。
 *
 * ## 判据（收窄到只说话的那一侧）
 *
 * 同时满足才报：
 *   1. 数组字面量里有 ≥3 个对象项；
 *   2. 这些对象里至少有一个**内容型字段**（name/title/price/img/desc…），
 *      纯 `key/label/value/icon` 的导航表不报；
 *   3. 该数组被 `.map(` 渲染；
 *   4. 本文件里没有任何取数入口（fetch / axios / useQuery / useSWR / prisma. / db. / trpc / getServerSideProps…）。
 *
 * 第 4 条是关键：只要文件里有取数，这个数组更可能是空态兜底或模板骨架，宁可放过。
 *
 * ## 声明式豁免：`// config-mirror: <单源路径> @ <比对守卫>`
 *
 * 有一类常量**永远**是本条的假阳性：它确实是写死的对象数组、确实被 `.map()` 渲染、
 * 本文件也确实没有取数入口 —— 因为它的真相源在**另一个进程**里。
 * 典型是小程序端把服务端的文案/页签表逐字镜像一份（`FEED_TABS` 镜像
 * `lib/config/copywriting.ts`），端上不可能去 fetch 服务端常量，而镜像必须存在
 * （小程序不能 import 服务端 TS）。
 *
 * 「这行数据有没有第二份真相」是静态不可知的，所以判据不去猜，而是要求**声明**：
 * 在该数组声明行的**正上方 3 行内**写一行
 *
 *     // config-mirror: lib/config/copywriting.ts @ test:mp:index-feed
 *
 * 左半是单源路径（必须含 `/`），右半是逐项比对的守卫（长度 ≥ 4）。
 * **两半都必需**：只写路径等于「我觉得它有个源」，不告诉任何人怎么证明它没漂；
 * 只写守卫等于「有个测试」，不知道比的是什么。缺任一半仍按原判据报。
 *
 * 为什么豁免必须贴在数组**上方**而不是文件头：文件级豁免一次放行整文件所有常量，
 * 而真正的假阳性永远只针对某一个表；贴在数组上方，新增常量不会搭便车。
 */
import { maskStringBodies, matchDelimiter, splitArgs, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** 模块级/组件级数组声明（`{` `(` 起始的对象数组一律不算） */
const ARRAY_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;{}]+?)?=\s*\[/g

/** 内容型字段：只有一个也算（宁可多报一条候选，也不漏掉线上假数据） */
const CONTENT_KEY = /\b(?:name|title|price|img|image|src|desc|description|content|author|date|status|amount|rating|cover|avatar|summary|address|phone|email)\b/

/** 取数入口：文件里有任意一个，本条就不说话 */
const DATA_SOURCE = /\b(?:fetch\s*\(|axios|useQuery|useSWR|useMutation|\bprisma\.|\bdb\.|\btx\.|trpc\.|getServerSideProps|getStaticProps|createServerAction|\.query\s*\()/

const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

/** `// config-mirror: <单源路径> @ <比对守卫>`（见文件头「声明式豁免」） */
const MIRROR_MARK = /\/\/\s*config-mirror:\s*([^\n]*)/

/**
 * 豁免标记是否**贴在**这个声明上方，且**两半都在**。
 *
 * `src` 是原文（标记在注释里，`stripComments` 之后就不存在了），
 * `declStart` 来自结构面 —— 两者偏移一致（`maskStringBodies` 逐字符等长）。
 */
function mirrorMarkAbove(src: string, declStart: number): boolean {
  // 只看本行之前 3 行（约 240 字符），远了就不是「贴在它上方」
  const from = Math.max(0, declStart - 240)
  const window = src.slice(from, declStart)
  const lines = window.split('\n')
  const tail = lines.slice(-4, -1) // 声明行自己由 declStart 截断，取前 3 整行
  for (const line of tail) {
    const m = MIRROR_MARK.exec(line)
    if (!m) continue
    const payload = m[1].trim()
    const at = payload.lastIndexOf('@')
    if (at < 0) continue
    const source = payload.slice(0, at).trim()
    const guard = payload.slice(at + 1).trim()
    // 左半必须是路径形态（含 `/`），右半必须像个守卫别名（≥4 字符、无空白）
    if (!source.includes('/')) continue
    if (guard.length < 4 || /\s/.test(guard)) continue
    return true
  }
  return false
}

export const aq13 = toGuard({
  id: 'aq13',
  title: '残留：页面写死对象数组当渲染数据源（需人裁决）',
  invariants: ['INV-RES-02'],
  code: 'AQ013_HARDCODED_DATASOURCE',
  level: 'warn',
  blindSpots: [
    '只认 `const X = [ … ]` 的对象字面量数组；接口返回后再 `setState` 的常量、变量拼接、`Array.from` 生成的数组不可见',
    '「是否取数」按**本文件内**的调用形态判断：取数写在自定义 hook / 服务端组件 / 父组件里时，会误报为候选（这是固定 warn 的原因）',
    '渲染判定只认 `X.map(`；透传给子组件、`X.length && …`、索引访问不判',
    '不用色阶/内容字段词表之外的常量（纯颜色表、图标表）不报，但同形的内容常量会漏',
    '`export const` 的配置常量同样会被报：它可能就是页面数据来源，需要人裁决',
    '`// config-mirror:` 豁免只验**形态**（路径含 `/` + 守卫长度 ≥4），不验那个守卫是否真的逐项比对了——它替代的是「人看一遍」，不是判据本身',
  ],
  impact:
    '页面里写死 ≥3 条结构相同的对象当渲染数据源，且本文件没有任何取数入口：' +
    '接口接通后这份常量常被留下，线上于是同时存在「接口数据」与「写死数据」，对账永远对不上',
  provenance:
    '试点 A（2026-10）：列表页先写死三条示例数据上线，接口接通后常量未删；运营发现明明有 27 条记录，页面只显示 3 条，而报表显示 24 条',
  applies(rel) {
    if (!/\.(?:tsx|jsx|ts|js|mts|mjs)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (NON_PROD.test(rel) || TEST_FILENAME.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    // 结构用抹过字符串的面（数组里的中文/URL 带逗号会切错位），行号与证据用原文
    const structural = maskStringBodies(stripComments(src))
    if (DATA_SOURCE.test(structural)) return []

    const hits: RawHit[] = []
    ARRAY_DECL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ARRAY_DECL.exec(structural)) !== null) {
      const name = m[1]
      const open = m.index + m[0].length - 1
      const close = matchDelimiter(structural, open)
      if (close < 0) continue
      const items = splitArgs(structural.slice(open + 1, close)).filter((s) => s.trim() !== '')
      const objects = items.filter((s) => s.trim().startsWith('{'))
      if (objects.length < 3) continue
      // 内容型字段在原文里看：结构面已经把字符串抹掉了，字段名仍在，但保险起见对两块取并
      const window = src.slice(open, close + 1)
      if (!CONTENT_KEY.test(window)) continue
      // 被当作渲染数据源：`X.map(` / `X?.map(`
      const renderRe = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\??\\.map\\s*\\(`)
      if (!renderRe.test(structural)) continue
      // 已声明「这是某个单源的镜像，且逐项比对在别处」—— 假阳性，不报
      if (mirrorMarkAbove(src, m.index)) continue

      hits.push({
        line: lineOf(src, m.index),
        message:
          `\`${name}\` 是写死的 ${objects.length} 条对象数组，并被 \`.map()\` 直接渲染，而本文件没有任何取数入口：` +
          '确认这是占位数据还是合法常量。若是占位数据，接口接通后请整体删除；' +
          '若是合法常量（筛选表/导航表），把内容型字段改成纯配置字段，或在此文件加取数入口；' +
          '若它是**另一个进程里那份单源的逐字镜像**（小程序端镜像服务端文案表即属此类），' +
          '在该数组声明行上方写 `// config-mirror: <单源路径> @ <比对守卫>` 豁免，两半都要写',
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '写死三条条目并 map 渲染（该报）',
      expect: 'warn',
      rel: 'src/app/items/page.tsx',
      src:
        "const items = [\n  { name: 'A', amount: 1, icon: '/a.png' },\n  { name: 'B', amount: 2, icon: '/b.png' },\n" +
        "  { name: 'C', amount: 3, icon: '/c.png' },\n]\n" +
        'export default function Page() { return <ul>{items.map((p) => <li key={p.name}>{p.name}</li>)}</ul> }\n',
    },
    {
      name: '四条记录、可选链 map（该报）',
      expect: 'warn',
      rel: 'src/app/records/page.tsx',
      src:
        "const rows = [{ title: 'a', amount: 1 }, { title: 'b', amount: 2 }, { title: 'c', amount: 3 }, { title: 'd', amount: 4 }]\n" +
        'export default function Page() { return <div>{rows?.map((r) => <span key={r.title}>{r.title}</span>)}</div> }\n',
    },
    {
      name: '只有两条（不该报）：数量不足以构成数据源',
      expect: 'green',
      rel: 'src/app/page.tsx',
      src: "const items = [{ name: 'a', price: 1 }, { name: 'b', price: 2 }]\nexport default () => <div>{items.map((i) => i.name)}</div>\n",
    },
    {
      name: '没有渲染（不该报）：常量未被页面消费',
      expect: 'green',
      rel: 'src/app/page.tsx',
      src: "const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]\nexport const total = items.length\n",
    },
    {
      name: '有取数入口（不该报）：可能是空态兜底',
      expect: 'green',
      rel: 'src/app/page.tsx',
      src:
        "const fallback = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]\n" +
        'export default async function Page() { const data = await fetch(\'/api/x\').then((r) => r.json()); return <div>{(data ?? fallback).map((i) => i.name)}</div> }\n',
    },
    {
      name: '纯导航表（不该报）：只有 key/label/icon',
      expect: 'green',
      rel: 'src/app/layout.tsx',
      src:
        "const tabs = [{ key: 'a', label: 'A', icon: 'x' }, { key: 'b', label: 'B', icon: 'y' }, { key: 'c', label: 'C', icon: 'z' }]\n" +
        'export default () => <nav>{tabs.map((t) => <a key={t.key}>{t.label}</a>)}</nav>\n',
    },
    {
      name: '注释里的数组（不该报）：去注释先于解析',
      expect: 'green',
      rel: 'src/app/page.tsx',
      src: "// const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]\n" + 'const items = [] as string[]\n',
    },
    {
      name: '测试文件（不该报）：样本不在射程',
      expect: 'green',
      files: {
        'src/app/__tests__/page.test.tsx': "const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]\nexport const n = items.map((i) => i.name)\n",
        'src/app/page.tsx': 'export default function Page() { return null }\n',
      },
    },
    {
      // 声明式豁免的正例：小程序端镜像服务端的文案表（真事：`FEED_TABS` 镜像
      // `lib/config/copywriting.ts`，逐项比对在 `test:mp:index-feed` 的 T-copy 组）。
      name: '贴了 config-mirror 且两半俱全（不该报）：单源在别的进程，比对在别处',
      expect: 'green',
      rel: 'src/app/feed-tabs.ts',
      src:
        '// config-mirror: lib/config/copywriting.ts @ test:mp:index-feed\n' +
        "const FEED_TABS = [{ name: '推荐', key: 'rank' }, { name: '小样区', key: 'sample' }, { name: '正装区', key: 'full' }]\n" +
        'export const tabs = FEED_TABS.map((t) => t.name)\n',
    },
    {
      // 只写路径不写守卫＝「我觉得它有个源」，不告诉任何人怎么证明它没漂 ⇒ 仍报
      name: 'config-mirror 只写了单源路径、没写比对守卫（仍该报）：豁免不能只表态',
      expect: 'warn',
      rel: 'src/app/feed-tabs.ts',
      src:
        '// config-mirror: lib/config/copywriting.ts\n' +
        "const FEED_TABS = [{ name: '推荐', key: 'rank' }, { name: '小样区', key: 'sample' }, { name: '正装区', key: 'full' }]\n" +
        'export const tabs = FEED_TABS.map((t) => t.name)\n',
    },
    {
      // 贴太远＝不是贴在它上方，而是顺手写在文件某处。
      // 全文级豁免一次放行整文件所有常量，新增常量会搭便车，所以距离要判。
      name: 'config-mirror 贴在十几行之外（仍该报）：豁免不许离开声明',
      expect: 'warn',
      rel: 'src/app/feed-tabs.ts',
      src:
        '// config-mirror: lib/config/copywriting.ts @ test:mp:index-feed\n' +
        ['const a1 = 1', 'const a2 = 2', 'const a3 = 3', 'const a4 = 4', 'const a5 = 5'].join('\n') +
        '\n' +
        "const FEED_TABS = [{ name: '推荐', key: 'rank' }, { name: '小样区', key: 'sample' }, { name: '正装区', key: 'full' }]\n" +
        'export const tabs = FEED_TABS.map((t) => t.name)\n',
    },
  ],
})
