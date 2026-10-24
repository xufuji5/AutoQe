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

  return cases
})()
