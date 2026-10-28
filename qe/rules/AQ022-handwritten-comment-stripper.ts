/**
 * AQ022 · 脚本里手写块注释剥离器（用正则替换代替共用解析层）。
 *
 * ## 缺陷形态
 *
 * 为了在脚本里读源码/取码面，顺手写一个「正则去注释」：
 *
 * ```ts
 * const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
 * ```
 *
 * 它看起来对，实际只处理了「代码态」——不认识字符串、模板串与行注释：
 *
 * - 字符串里的注释符号会被当成注释起点，**吞掉后面的真代码**；
 * - 行注释里的块注释开场符会开启一个不存在的块注释，一直吃到下一个闭合符；
 * - 未配对的块注释开场符会让整段被静默丢弃。
 *
 * 三种结果都不抛错，只让判据「少认一批对象」，而少认在报告上与「没有问题」长得一样。
 * 这类事故在本仓出现过两次，所以注释剥离**只有一份实现**（`code-only` 层），
 * 任何脚本再手写一份，都会在某个文件上悄悄改写判据的输入。
 *
 * ## 判据（形态可复算）
 *
 * 在脚本类文件里，`.replace(<第一参>, …)` / `.replaceAll(<第一参>, …)` 的第一参是**正则字面量**，
 * 且归一化后同时包含块注释的开场符与闭合符（去掉反斜杠转义与空白再判断），即报。
 *
 * 只认「同一个 replace 里同时出现开场与闭合」的形态：只 remove 开场符、或只 remove 闭合符的
 * 不是完整剥离器，可能另有用途；分成 `split(...).join(...)` 或多次 replace 的写法不在射程。
 *
 * ## 为什么是 warn
 *
 * 少量已知形态（例如只处理 README 里的代码块）手写替换可能人手核过。机器能证死的只是
 * 「这里有一份独立于共用层的注释剥离实现」，不能证死「它一定读错」——
 * 但读错的代价落在它下游的所有判据上，所以固定出候选，由人裁决是否换成共用实现。
 */
import { argSpanAt, maskRegexBodies, maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec)\./

/** 归一化：去掉反斜杠转义与所有空白，只留下模式字符 */
function normalizePattern(text: string): string {
  return text.replace(/\\(.)/g, '$1').replace(/\s+/g, '')
}

/**
 * 第一参是否是一份「块注释剥离模式」。
 *
 * 只认同时含开场符与闭合符的模式：只要一种符号的替换不是剥离器。
 */
function isBlockCommentStripper(pattern: string): boolean {
  const p = normalizePattern(pattern)
  return p.includes('/*') && p.includes('*/')
}

/**
 * 第一参是否为正则字面量。
 *
 * 字符串里的注释符号没有任何「模式」含义：把一段 glob 路径替换成空串只是文本替换，
 * 不是「剥离注释」的模式。旧实现只看归一化后是否含开场/闭合符，会把这类替换误报成剥离器。
 */
function isRegexLiteral(text: string): boolean {
  const t = text.trim()
  return t.startsWith('/') && t.length > 2 && /\/[A-Za-z]*$/.test(t)
}

export const aq22 = toGuard({
  id: 'aq22',
  title: '脚本里手写块注释剥离器（绕开共用的代码面解析层）',
  invariants: ['INV-META-06'],
  code: 'AQ022_HANDWRITTEN_COMMENT_STRIPPER',
  level: 'warn',
  blindSpots: [
    '射程只到 `scripts` / `tools` / `ci` 目录，或文件名含 `code-only` / `strip-comments` 的文件；其它位置的同类实现不扫',
    '只认 `.replace` / `.replaceAll` 且第一参是正则字面量、归一化后同时含块注释开场符与闭合符：字符串模式（例如 glob 路径 `/**/`）、`new RegExp(…)`、`split(...).join(...)`、多次 replace、先 replace 再过滤的写法不可见',
    '归一化只做「去反斜杠 + 去空白」：用字符集拼接（`new RegExp("[" + x + "]")`）、从常量/配置读模式的写法不可复算',
    '不判断这份实现是否真的被用在判据的取码路径上（那是数据流）：出现即出候选',
    '行注释（`//`）的同类手写剥离不在本条射程——它不会吞掉块注释边界，风险低一个量级',
  ],
  impact:
    '脚本用手写正则剥离块注释：不认字符串/模板串/行注释，字符串里的注释符会吞掉后面的真代码，' +
    '未配对的块注释开场符会让整段被静默丢弃；下游判据少认一批对象，而在报告上与「没有问题」无法区分',
  provenance:
    '试点 C（2026-09）：某脚本用块注释正则替换取码面，一个文件的行注释里写着块注释开场符，' +
    '整段被吃到下一个闭合符，识别到的编码从 472 掉到 404；脚本自己打印的是「解析完成」，没有任何错误信号',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (NON_PROD.test(rel) || TEST_FILENAME.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    const base = (rel.split('/').pop() ?? '').replace(/\.\w+$/, '')
    if (/(?:code-only|strip-?comments?|comment-strip)/i.test(base)) return true
    return /(^|\/)(?:scripts|tools|ci)\//.test(rel)
  },
  /** 脚本按定义不在源码树里：射程补上 `scriptsDirs`（默认 `scripts`），其它规则不受影响 */
  extraRoots(ctx) {
    const dirs = ctx.config.scriptsDirs ?? ['scripts']
    return dirs.filter((d) => typeof d === 'string' && d !== '' && !d.includes('..'))
  },
  analyze(src, _rel, ctx: RuleCtx): RawHit[] {
    const code = stripComments(src)
    const masked = maskStringBodies(code)
    // 结构取样必须再抹掉正则体：第一参就是正则，里面的 `(`/`)`/`[`/`]` 会让实参切分提前闭合，
    // 结果是拿到半截模式或直接 null，整条命中静默消失（这是本条自己最容易犯的错）。
    const structural = maskRegexBodies(masked)
    const hits: RawHit[] = []
    const REPLACE = /\.(?:replace|replaceAll)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = REPLACE.exec(structural)) !== null) {
      const open = m.index + m[0].length - 1
      const arg = argSpanAt(structural, open, 0)
      if (arg === null) continue
      // 模式原文取未掩码面（掩码会把字符串/正则内容抹成空白），位置与掩码面等长
      const pattern = code.slice(open + 1, open + 1 + arg.length)
      if (!isRegexLiteral(pattern)) continue
      if (!isBlockCommentStripper(pattern)) continue
      hits.push({
        line: lineOf(src, m.index),
        message:
          '脚本里手写块注释剥离（`replace(<含块注释开场/闭合的模式>, …)`）：' +
          '它不认字符串、模板串与行注释，会把字符串里的注释符当真注释、也会被未配对的开场符带偏，' +
          '静默少认后面的真代码。改用共用的注释剥离实现（`code-only` 层），不要在脚本里再写一份',
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '正则替换剥块注释（该报）：字符串里的注释符会吞掉后文',
      expect: 'warn',
      rel: 'scripts/normalize-source.ts',
      src:
        'export function clean(src: string): string {\n' +
        "  return src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')\n" +
        '}\n',
    },
    {
      name: '正则把开场/闭合符一起删掉（该报）：同一模式含两种定界符',
      expect: 'warn',
      rel: 'tools/read-codes.ts',
      src:
        'export function clean(src: string): string {\n' +
        "  return src.replace(/\\/\\*|\\*\\//g, '')\n" +
        '}\n',
    },
    {
      name: '改用共用的注释剥离层（不该报）：唯一实现只有一份',
      expect: 'green',
      rel: 'scripts/normalize-source.ts',
      src:
        "import { stripComments } from '../qe/lib/code-only.ts'\n" +
        'export function clean(src: string): string {\n' +
        '  return stripComments(src)\n' +
        '}\n',
    },
    {
      name: '只剥行注释（不该报）：不含块注释开场/闭合符',
      expect: 'green',
      rel: 'scripts/normalize-source.ts',
      src:
        'export function clean(src: string): string {\n' +
        "  return src.replace(/\\/\\/[^\\n]*/g, '')\n" +
        '}\n',
    },
    {
      name: 'replaceAll 剥块注释（该报）：同样的私有解析层，换了个方法名',
      expect: 'warn',
      rel: 'scripts/normalize-source.ts',
      src:
        'export function clean(src: string): string {\n' +
        "  return src.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, '')\n" +
        '}\n',
    },
    {
      name: '正则体里带未配对括号（该报）：结构配对必须先抹正则体，否则整条命中消失',
      expect: 'warn',
      rel: 'scripts/normalize-source.ts',
      src:
        'export function clean(src: string): string {\n' +
        "  return src.replace(/\\/\\*[\\s\\S]*?\\*\\/|[(]/g, '')\n" +
        '}\n',
    },
    {
      name: '字符串里的 glob 路径（不该报）：字符串不是剥离模式',
      expect: 'green',
      rel: 'scripts/rewrite-paths.ts',
      src:
        'export function clean(p: string): string {\n' +
        "  return p.replace('/**/*.ts', '')\n" +
        '}\n',
    },
    {
      name: '普通路径替换（不该报）：第一参不含块注释符',
      expect: 'green',
      rel: 'scripts/rewrite-paths.ts',
      src:
        'export function clean(p: string): string {\n' +
        "  return p.replace('/old/', '/new/')\n" +
        '}\n',
    },
  ],
})
