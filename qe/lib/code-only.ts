/**
 * 代码面提取：注释剥离 / 字符串掩码 / 结构取样（+ 自带自证例）
 *
 * 抽取自一处生产仓的 `scripts/lib/code-only.ts`（那个文件在那边拦下过两次真实事故）。
 *
 * ## 为什么任何静态判据都必须先过这一层
 *
 * 同一类事故出现过两次，两次都是「描述语法的文本里写了语法定界符字面量」：
 *   ① 某个 import 扫描器把**自己文件头注释**里的 `import ... from '@/x'` 当成真 import；
 *   ② 有人在注释里写出了块注释闭合符本身，块注释当场提前闭合，esbuild 报语法错。
 *
 * 判据侧的同款事故更贵：一个未配对的块注释开场符会让任何「先正则剥块注释再取键」的实现
 * 从该行一直吃到下一个闭合符，实测只认出 404 个码（真实 472），**且静默通过** ——
 * 少认的那些里若有死映射，判据永远抓不到。
 *
 * ## 纪律
 *
 * 1. 注释/文档里描述定界符时**禁止写字面量**，改用数量描述（「开场符 5 个 / 闭合符 4 个」）。
 * 2. 任何解析源码的判据必须走本模块，**禁手写「块注释正则替换」**（非贪婪版）：
 *    该写法不认字符串、不认「行注释里的开场符」，两种都会吃掉真代码。
 * 3. 自证例 `CODE_ONLY_SELFTEST` 必须被 `autoqe selftest` 跑到 ——
 *    工具自己错了，所有用它的判据一起错，而且错得安静。
 */

/** 扫描态：代码 / 行注释 / 块注释 / 单引号 / 双引号 / 模板串 */
type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

/** 正则字面量可能出现的「前一个有意义字符」（`/` 在右括号后按除号处理，宁可漏认不误吞） */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])
/** 关键字形态：`return /x/`、`case /x/`（不能只看前一个字符） */
const REGEX_KEYWORD_BEFORE = /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|delete|void|new|yield|await|match|test|replace|split|exec)\s*$/

function prevSignificant(out: string): string {
  let k = out.length - 1
  while (k >= 0 && (out[k] === ' ' || out[k] === '\t' || out[k] === '\n' || out[k] === '\r')) k--
  return k >= 0 ? out[k] : ''
}

/**
 * 从 `at` 处的 `/` 起，若有**同一行内闭合**的正则字面量，返回其长度（含两端斜杠与标志位前的部分）。
 * 不是正则字面量返回 0。
 *
 * ## 为什么必须有这一条
 *
 * 手写扫描器只认「代码/注释/字符串」三态时，`s.match(/^https?:\/\/([^/`'"?${]+)/)` 这类
 * **字符类里带引号或反引号的正则**会让扫描态错位：反引号被当成模板串开场，此后整个文件都
 * 按「字符串内容」原样透传 —— 注释不再被剥，于是判据开始把**文档文字当代码**报缺陷。
 *
 * 实测代价：一个文件里 7 条命中全落在 JSDoc 的示例行上，真缺陷 0 条，而报告看起来"很有料"。
 * 这类假绿/假红不会自己暴露，只能靠扫描器认全定界符。
 *
 * 纪律：认不出来时**退回原语义**（不跳），宁可让判定失败也不假装认出了正则。
 */
function regexLiteralLength(src: string, at: number, out: string): number {
  const prev = prevSignificant(out)
  const keywordOk = REGEX_KEYWORD_BEFORE.test(out.slice(Math.max(0, out.length - 16)))
  if (prev !== '' && !REGEX_PRECEDERS.has(prev) && !keywordOk) return 0
  let j = at + 1
  let inClass = false
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '\n' || ch === '\r') return 0 // 正则不跨行
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      return j - at + 1 >= 3 ? j - at + 1 : 0
    }
    j += 1
  }
  return 0
}

/**
 * 剥掉注释，**保留字符串字面量**（字符串里的 `//` 不是注释），并按原样保留换行，
 * 使行号与原文一一对应（判据要报行号）。
 *
 * 关键性质：行注释内部的块注释开场符是注释文本，不开启块注释。
 *
 * `keepUrlSlashes`（默认 true）：`//` 前一个非空字符是 `:` 时不当作注释。
 * 这是为 `const u = 'https://x'` 之外的裸写 URL 场景留的兜底（例如模板外拼接），
 * 代价是 `x://这行剩下的不是注释` 会保留下来 —— 该形态在真实代码里不存在，
 * 而「砍掉 https 之后整行被吞」是真实发生过的误判。
 */
export function stripComments(src: string, opts: { keepUrlSlashes?: boolean } = {}): string {
  const keepUrl = opts.keepUrlSlashes !== false
  let out = ''
  let mode: Mode = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        if (keepUrl) {
          let k = out.length - 1
          while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--
          if (k >= 0 && out[k] === ':') {
            out += '//'
            i += 2
            continue
          }
        }
        mode = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === '/') {
        const len = regexLiteralLength(src, i, out)
        if (len > 0) {
          out += src.slice(i, i + len)
          i += len
          continue
        }
      }
      if (c === "'") {
        mode = 'sq'
        out += c
        i += 1
        continue
      }
      if (c === '"') {
        mode = 'dq'
        out += c
        i += 1
        continue
      }
      if (c === '`') {
        mode = 'tpl'
        out += c
        i += 1
        continue
      }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += '\n'
      } else out += ' '
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // 字符串态：转义整对吞掉，闭合符回到代码态
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code'
      out += c
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * 把字符串**内容**抹成空白（保留引号、**保留字符数与换行**），用于结构取样时排除字符串里的伪语法。
 * 只在已 `stripComments` 的代码面上调用。
 *
 * 为什么是「抹成空白」而不是删掉内容：删会改变长度。行号尚可靠「换行是否保留」撑住，
 * 但**列偏移**会错位，且跨行模板串一旦被压平就连行号也保不住。判据要报行号，
 * 报错行号错位等于把人送到错误位置。
 */
export function maskStringBodies(code: string): string {
  let out = ''
  let i = 0
  const n = code.length
  type S = 'code' | 'sq' | 'dq' | 'tpl'
  let state: S = 'code'
  while (i < n) {
    const c = code[i]
    if (state === 'code') {
      if (c === '/') {
        const len = regexLiteralLength(code, i, out)
        if (len > 0) {
          out += code.slice(i, i + len)
          i += len
          continue
        }
      }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'tpl'
      out += c
      i += 1
      continue
    }
    if (c === '\\') {
      out += code[i + 1] === '\n' ? ' \n' : '  '
      i += 2
      continue
    }
    const closer = state === 'sq' ? "'" : state === 'dq' ? '"' : '`'
    if (c === closer) {
      state = 'code'
      out += c
      i += 1
      continue
    }
    out += c === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}

/**
 * 把**正则字面量的内容**抹成空白（保留两端斜杠与标志位，**保留字符数与换行**）。
 * 只在已 `maskStringBodies` 的代码面上调用。
 *
 * ## 为什么这层不能省
 * `maskStringBodies` 对正则字面量是**原样保留**（它要保住 `replace(/a/g, 'b')` 的可读性）。
 * 但正则里完全可能出现未配对的括号，例如 `s.split(/[{,(]/)`。
 * 任何靠深度计数判断「这个调用是不是写在回调里/函数体里」的判据，
 * 遇到这种正则都会被带偏一格：要么把外层函数体提前判成结束，要么把嵌套调用当成顶层调用。
 *
 * 这类错**不抛异常、不报 0 命中以外的任何信号**，只是把结论换成相反的那个。
 * 实测形态：一个 `attached` 里的 `wx.nextTick(() => this.setData(…))` 被当成「顶层 setData」报了红——
 * 正则出现在同一个函数的前几行。判据对着自己的误读下了结论。
 *
 * 纪律：结构取样（深度、配对、跨度）一律用
 * `maskRegexBodies(maskStringBodies(stripComments(src)))`，三步缺一不可。
 */
export function maskRegexBodies(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    if (code[i] === '/') {
      const len = regexLiteralLength(code, i, out)
      if (len > 0) {
        const literal = code.slice(i, i + len)
        const flagsAt = literal.lastIndexOf('/')
        const flags = flagsAt > 0 ? literal.slice(flagsAt + 1) : ''
        // 内容抹空，斜杠与标志位留在原位：偏移不变，括号不再参与深度
        out += '/' + ' '.repeat(Math.max(0, len - 1 - flags.length)) + flags
        i += len
        continue
      }
    }
    out += code[i]
    i += 1
  }
  return out
}

/** 该行是否可能是代码语句。排除：空行、行注释开行、块注释续行（星号打头）、块注释开行、块注释收尾行。 */
export function isCodeStatementLine(line: string): boolean {
  const t = line.trim()
  if (t === '') return false
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
}

/** 该行是否以 import / export 开头，或是跨行 import 的收尾行（含说明符的那一行） */
export function startsImportOrExport(line: string): boolean {
  if (!isCodeStatementLine(line)) return false
  // 收尾行必须单独认：`}` 是非单词字符，`\b` 在其后恒不成立（旧实现因此静默漏掉全部多行 import）
  return /^\s*(?:import|export)\b/.test(line) || /^\s*\}\s*from\s*['"]/.test(line)
}

/** 从一个文件正文里取全部静态 import 说明符（注释与字符串内的伪 import 不算） */
export function importSpecsFrom(src: string): string[] {
  const code = stripComments(src)
  const out: string[] = []
  for (const line of code.split('\n')) {
    if (!startsImportOrExport(line)) continue
    const m = /from\s+(['"])([^'"]+)\1/.exec(line)
    if (m) out.push(m[2])
  }
  return out
}

/**
 * 取全部 `if (...)` 的判定条件文本（归一化后可比对）。
 * 用途：两侧镜像文件「分支对等」——算法加了一条分支而只加在一侧，这里必须不等。
 */
export function ifConditions(src: string): string[] {
  const code = maskStringBodies(stripComments(src))
  const out: string[] = []
  const re = /\bif\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    let depth = 1
    let j = m.index + m[0].length
    const start = j
    while (j < code.length && depth > 0) {
      if (code[j] === '(') depth += 1
      else if (code[j] === ')') depth -= 1
      j += 1
    }
    out.push(code.slice(start, j - 1).replace(/\s+/g, '').replace(/"/g, "'"))
  }
  return out
}

/** 取 `module.exports = { a, b }` 的键名（CJS 侧导出面对比用） */
export function commonJsExportKeys(src: string): string[] {
  const code = stripComments(src)
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\}/.exec(code)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].trim())
    .filter(Boolean)
}

/** 取 ESM 顶层**值**导出（function/const/let/class）名；类型导出不参与运行面对比 */
export function esmValueExportKeys(src: string): string[] {
  const code = stripComments(src)
  const out: string[] = []
  const re = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.push(m[1])
  return out.sort()
}

export type SelfCase = { name: string; ok: boolean; detail?: unknown }

/* ============================================================================
 * 结构取样：把「某个开定界符 → 它的配对标点」这一段的原文切出来
 *
 * 为什么它也在这层：凡是「看某个调用的实参/函数体长什么样」的判据都要做括号配对，
 * 配对写错一次的表现是**静默错位**——切到隔壁函数、或者切出空串。两种结果在读数上都
 * 长成「0 命中」，与「真的没有违规」无法区分，这是判据侧最贵的一种假绿。
 *
 * 纪律：
 *  1. 必须在 `stripComments` + `maskStringBodies` + `maskRegexBodies` 之后调用。
 *     字符串与正则里的括号会让深度错位，而错位不抛错，只切错。
 *  2. 不配对一律返回 `null` / `-1`，调用方据此**不报**：看不清不等于有缺陷。
 *  3. 不同括号类型各算各的深度（`f({a: g(1)})` 里找 `(` 的配对只数圆括号）。
 * ========================================================================== */

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** 从 `open` 处（必须是 `(` `[` `{` 之一）配对到同名闭合符，返回其下标；不配对返回 -1 */
export function matchDelimiter(code: string, open: number): number {
  const opener = code[open]
  const closer = CLOSER[opener]
  if (!closer) return -1
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === opener) depth++
    else if (c === closer) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** `{` 处取花括号体（不含两端括号）；不是 `{` 或不配对返回 null */
export function braceBody(code: string, open: number): string | null {
  if (code[open] !== '{') return null
  const end = matchDelimiter(code, open)
  return end < 0 ? null : code.slice(open + 1, end)
}

/** `(` 处取圆括号体（不含两端括号）；不是 `(` 或不配对返回 null */
export function parenBody(code: string, open: number): string | null {
  if (code[open] !== '(') return null
  const end = matchDelimiter(code, open)
  return end < 0 ? null : code.slice(open + 1, end)
}

/** 按顶层逗号切分（三种括号的深度都计入） */
export function splitArgs(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i))
      start = i + 1
    }
  }
  const tail = inner.slice(start)
  if (tail.trim() !== '' || out.length > 0) out.push(tail)
  return out
}

/**
 * 第 `index` 个实参的原文（0 起）。调用点不在 `(` 上、或括号不配对时返回 null。
 *
 * 为什么按「实参位置」而不是正则截一段：
 * `foo(a, true, b)` 里用 `/,\s*true\s*,/` 去认第二个参数，会把消息串里的 `,true,`
 * 一起吃掉，也会把 `findIndex()` 返回 -1 的「没找到」当成「找到了 0 号位」。
 * 按顶层逗号切分只认语法位置，这两种错都不会发生。
 */
export function argSpanAt(code: string, openParen: number, index: number): string | null {
  if (code[openParen] !== '(') return null
  const end = matchDelimiter(code, openParen)
  if (end < 0) return null
  const arg = splitArgs(code.slice(openParen + 1, end))[index]
  return arg === undefined ? null : arg
}

/**
 * 从 `from` 处向后跳过空白与 `=>`/`async`，返回紧随的函数体：
 * 花括号体返回其内容；表达式体（单行箭头）返回到行尾。认不出形态返回 null。
 */
export function bodyAfterParen(code: string, from: number): string | null {
  let i = from
  const skipWs = () => {
    while (i < code.length && /\s/.test(code[i])) i++
  }
  skipWs()
  if (code.startsWith('=>', i)) {
    i += 2
    skipWs()
  }
  if (code[i] === '{') {
    const end = matchDelimiter(code, i)
    return end < 0 ? null : code.slice(i + 1, end)
  }
  // 表达式体取到行尾：判据只关心「这一行里有没有写视图」，跨行拼接反而会误伤下一句
  const nl = code.indexOf('\n', i)
  const tail = code.slice(i, nl < 0 ? code.length : nl).trim()
  return tail === '' ? null : tail
}

/**
 * 把「一个实参」解析成「回调体原文」。
 *
 * 内联函数/箭头：实参原文就是回调体（足够判里面有没有写视图）。
 * 具名引用：回溯一次声明（函数声明 / `const x = () =>` / `const x = function ()`），
 * 认不出返回 null（→ 调用方不报：看不清就不报）。
 *
 * 放在这里而不是某条规则里：定时器、`.then`、`wx.request` 的 success 回调
 * 都要做同一件事，各写一份必然在「具名引用怎么回溯」上分叉。
 */
export function resolveCallbackBody(code: string, arg: string): string | null {
  const trimmed = arg.trim()
  if (trimmed === '') return null
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed
  const name = escapeRe(trimmed)

  const forms = [
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g'),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\b[^(]*)?\\(`, 'g'),
  ]
  for (const form of forms) {
    const m = form.exec(code)
    if (!m) continue
    const open = m.index + m[0].length - 1
    const close = matchDelimiter(code, open)
    if (close < 0) continue
    const body = bodyAfterParen(code, close + 1)
    if (body !== null) return body
  }
  return null
}

/**
 * 正则转义。**本树只此一份**：`$` 在标识符里合法、进正则就是锚点，
 * 而这个转义会被「用变量名拼正则」的所有判据用到（别名、具名回调）。
 * 各写一份的结果是某处漏掉 `$`，然后那条判据在带 `$` 的名字上静默失效。
 */
export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 自证例：工具必须先证明它处理得了「语法定界符出现在非法位置」的每一种形态。
 * `autoqe selftest` 会跑这批用例；任一失败即说明所有静态规则一起失真。
 */
export const CODE_ONLY_SELFTEST: SelfCase[] = (() => {
  const cases: SelfCase[] = []
  const push = (name: string, ok: boolean, detail?: unknown) => cases.push({ name, ok, detail })

  // 1. 行注释里的块注释开场符不得开启块注释
  const a = stripComments("// 4.14 Agent 接入（/api/agent/v1/* 与 /api/mcp）\nconst A = 1\n")
  push('行注释内的块注释开场符不吞后续代码', a.includes('const A = 1'), a)

  // 2. 块注释里的伪 import 不得被当成真 import
  const pseudoImport = stripComments("/*\nimport x from '@/x'\n*/\nconst B = 2\n")
  push('块注释内的伪 import 不计入 import 面', !pseudoImport.includes("from '@/x'"), pseudoImport)

  // 3. 字符串里的注释符不是注释
  const inString = stripComments("const u = 'http://x/*y';\nconst C = 3\n")
  push('字符串内的注释符不吞后续代码', inString.includes('const C = 3') && inString.includes("'http://x/*y'"), inString)

  // 4. 模板串里的斜杠不是注释
  const inTpl = stripComments('const t = `https://a/${b}`\nconst D = 4\n')
  push('模板串内的斜杠不被当作行注释', inTpl.includes('const D = 4'), inTpl)

  // 5. 字符串内的块注释闭合符不得提前结束块注释
  const closer = stripComments("/* 说明 */ const s = 'x';\nconst E = 5\n")
  push('字符串内的闭合符不影响块注释边界', closer.includes('const E = 5'), closer)

  // 6. import 行判定：真 import 认，注释形态不认
  push('真 import 行被认出', startsImportOrExport("import a from '@/a'"))
  push('块注释续行里的伪 import 不被认出', !startsImportOrExport(" * import a from '@/a'"))
  push('行注释里的伪 import 不被认出', !startsImportOrExport("// import a from '@/a'"))
  push('单行块注释里的伪 import 不被认出', !startsImportOrExport("/* import a from '@/a' */"))
  push('跨行 import 的 } 收尾行被认出', startsImportOrExport("} from '@/a'"))
  push('变量赋值里的 import 字样不被认出', !startsImportOrExport("const s = \"import a from '@/a'\""))

  // 7. 整个文件取谱
  const specs = importSpecsFrom("/*\nimport fake from '@/fake'\n*/\nimport real from '@/real'\n")
  push('importSpecsFrom 只取真 import', specs.length === 1 && specs[0] === '@/real', specs)

  // 8. if 条件取样
  const conds = ifConditions("if (a === 1) {}\nconst s = 'if (fake)'\nif (b > 2 && c) {}\n")
  push('ifConditions 不把字符串里的伪 if 计入', conds.length === 2, conds)
  push(
    'ifConditions 条件归一化（空白与引号风格）',
    ifConditions("if ( x  !==  \"1\" ) {}")[0] === ifConditions("if(x!=='1'){}")[0],
  )

  // 9. 字符串内容遮蔽：长度与换行都保住，引号对保留
  const src = "const a = 'prisma.user.update'\nconst b = `x\ny`\n"
  const masked = maskStringBodies(src)
  push(
    'maskStringBodies 保留总长度与换行数（行号可定位）',
    masked.length === src.length && masked.split('\n').length === 4 && !masked.includes('prisma'),
  )
  push('maskStringBodies 保留引号对（结构可辨）', maskStringBodies("a = 'x'") === "a = ' '")
  push('maskStringBodies 内嵌引号不提前收尾', !maskStringBodies("a = 'it\\'s ok'").includes('ok'))

  // 10. URL 兜底：`//` 前是冒号时不剥（否则整行被吞）
  const url = stripComments('const u = http://a\nconst F = 6\n')
  push('裸写 URL 的 // 不吞后续代码', url.includes('const F = 6'), url)
  const noUrl = 'const u = http://a; const G = 7\n'
  push(
    '显式关闭该兜底后按标准语义剥（证明开关有效）',
    stripComments(noUrl).includes('const G') && !stripComments(noUrl, { keepUrlSlashes: false }).includes('const G'),
    stripComments(noUrl, { keepUrlSlashes: false }),
  )

  // 11. 正则字面量：字符类里带引号/反引号时，扫描态不得错位（错位的代价见 regexLiteralLength 注释）
  const regexClass = stripComments("const m = s.match(/^https?:\\/\\/([^/`'\"?${]+)/)\n/**\n * 例：await req.json()\n */\nconst H = 8\n")
  push(
    '正则字符类内的引号/反引号不破坏后续注释剥离',
    !regexClass.includes('req.json') && regexClass.includes('const H = 8'),
    regexClass,
  )
  const division = stripComments('const half = total / 2\n// 说明\nconst I = 9\n')
  push('除号不被误认成正则（既不吞代码也不漏剥注释）', division.includes('const I = 9') && division.includes('total / 2'), division)
  const maskedRegex = maskStringBodies("const m = /[^']/\nconst J = 1")
  push('maskStringBodies 不把正则内的引号当字符串开场', maskedRegex.includes('const J = 1'), maskedRegex)

  // 12. maskRegexBodies：正则里的括号不得参与深度计数
  //     反证来自一次真实误报：`attached` 里的 `wx.nextTick(() => this.setData(…))` 被判成顶层调用，
  //     因为同一个函数前几行有个 `split(/[{,(]/)`，正则里的括号把深度带偏了一格。
  const DELIM_SRC = 'function f(s) { return s.split(/[{,(]/).length }'
  const braceDelta = (t: string) => (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length
  push(
    '正则掩码：反证成立——不掩码时正则里的括号让花括号深度失衡',
    braceDelta(DELIM_SRC) !== 0,
    braceDelta(DELIM_SRC),
  )
  const maskedDelims = maskRegexBodies(maskStringBodies(DELIM_SRC))
  push('正则掩码：掩码后花括号深度回到平衡', braceDelta(maskedDelims) === 0, braceDelta(maskedDelims))
  push(
    '正则掩码：长度逐字符不变（偏移/列号不能错位）',
    maskedDelims.length === maskStringBodies(DELIM_SRC).length,
    [maskedDelims.length, DELIM_SRC.length],
  )
  push(
    '正则掩码：标志位保留（否则后续解析认不出字面量边界）',
    /^\/\s+gi$/.test(maskRegexBodies('const r = /a/gi').slice('const r = '.length)),
    maskRegexBodies('const r = /a/gi'),
  )
  push(
    '正则掩码：除号不被当正则（`a / b` 后面没有闭合斜杠，必须原样留下）',
    maskRegexBodies('const x = a / b') === 'const x = a / b',
    maskRegexBodies('const x = a / b'),
  )

  // 13. 括号配对 / 实参切分
  push(
    '括号配对：不同括号类型各算各的深度（花括号不配对不影响圆括号的结果）',
    matchDelimiter('f({a:1)', 1) === 6,
    matchDelimiter('f({a:1)', 1),
  )
  push('括号配对：不配对返回 -1（调用方据此不报，不许当成 0 号位）', matchDelimiter('f(a, b', 1) === -1)
  push(
    '实参切分：消息串里的逗号不参与切分（传入的是已抹过字符串的代码面）',
    splitArgs(maskStringBodies(" a , 'x,y' , c ")).length === 3,
    splitArgs(maskStringBodies(" a , 'x,y' , c ")),
  )
  push('实参切分：对象字面量里的逗号不参与切分', splitArgs('{a: 1, b: 2}, 3').length === 2, splitArgs('{a: 1, b: 2}, 3'))
  push('实参切分：越界返回 null（不是空串，也不是 0 号位）', argSpanAt('f(a, b)', 1, 5) === null, argSpanAt('f(a, b)', 1, 5))
  push(
    '函数体取值：名字引用与外层括号分得开（`function f(a) {…}` 取到花括号体）',
    bodyAfterParen('function f(a) { return 1 }', 14) === ' return 1 ',
    bodyAfterParen('function f(a) { return 1 }', 14),
  )

  return cases
})()
