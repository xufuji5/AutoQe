/**
 * AQ011 · 子进程的可执行路径必须由运行时解析
 *
 * ## 真实事故形态（同一个人连栽两次）
 *
 * 夹具脚本要跑一段 TypeScript，于是把运行时 CLI 的路径写死：
 *
 * ```ts
 * const cli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
 * spawnSync(process.execPath, [cli, 'probe.ts'])
 * ```
 *
 * 在开发机上一直正常——因为 `node_modules` 就在那里。而在**干净 checkout**
 * （`git worktree add --detach`、CI 的浅克隆、别人的机器）里那个目录**不存在**，
 * 于是子进程立刻失败、**零输出**。上游把「零输出」读成了「被测代码抛穿了」，
 * 也就是：**探针结论缺失被当成被测对象有缺陷**，方向完全反了。
 *
 * 第二次栽在同一个假设的变体上：以为 `process.argv[1]` 是运行时 CLI。
 * 它其实是被执行的**脚本**路径（tsx 会把它重写成入口文件），拿它当 CLI 跑
 * 等于把被测文件当解释器启动。两次都不是「代码写错」，是**事实记错**。
 *
 * ## 判据
 *
 * 同一文件内，以下两种形态报红（都必须与子进程调用**同文件**且**同语句**）：
 *
 * 1. 字符串字面量里含依赖目录（`node_modules`），且
 *    - 该字面量所在行就是一条 `spawn/exec/fork` 调用；或
 *    - 该字面量被赋给某个变量，而后续子进程调用里出现了这个变量名。
 * 2. 子进程调用的实参里直接出现 `process.argv[1]`。
 *
 * ## 为什么必须和 spawn 同语句
 *
 * `'node_modules 未安装'` 这种日志文案在同一文件里很常见。只判「文件里同时出现
 * node_modules 与 spawn」会在每个带安装提示的脚本上报红——那种报红改不动，
 * 改不动就会被人关掉，规则等于不存在。**要求同一个数据流**才既窄又可证死。
 *
 * ## 修复形态
 *
 * 不要写死路径，从仓库根**向上逐级**找（worktree 形状下 `node_modules` 常在更上层）：
 *
 * ```ts
 * const cli = findUp('node_modules/tsx/dist/cli.mjs')  // 逐级存在性探测，找不到就抛
 * ```
 *
 * 「找不到就抛」是关键：宁可让夹具明确失败，也不要以零输出混进结论。
 */
import { matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** 子进程家族：只要有其中一个，本文件就进入射程 */
const SPAWN_CALL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/
/** 含依赖目录的字符串字面量（含 `'node_modules'` 这种分段写法） */
const DEP_LITERAL = /(['"`])([^'"`\n]*\bnode_modules\b[^'"`\n]*)\1/g
/** 被当成运行时 CLI 的脚本参数 */
const ARGV1 = /\bargv\s*\[\s*1\s*\]/
const VAR_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/

/**
 * `argv[1]` 是否落在某条子进程调用的**第一个实参**（命令位）里。
 *
 * 这是本规则第一版最大的误报源：`spawnSync('npx', ['tsx', argv[1], '--digest'])` 是
 * **正确**写法（用 npx 跑「自己这个脚本」），argv[1] 在第二个实参里。真实仓库一跑就
 * 命中它，而它改不动——改了脚本就没法自跑了。只有放在命令位（`spawnSync(argv[1], …)`）
 * 才是「把入口文件当解释器」，才是本条要抓的。
 */
function inCommandPosition(code: string, at: number): boolean {
  const re = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g
  let last: RegExpExecArray | null = null
  let cur: RegExpExecArray | null
  while ((cur = re.exec(code)) !== null && cur.index < at) last = cur
  if (last === null) return false
  const open = last.index + last[0].length - 1
  const end = matchDelimiter(code, open)
  if (end < 0) return false
  let depth = 0
  for (let i = open + 1; i < end; i++) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) return at < i
  }
  return at < end
}

export const aq11 = toGuard({
  id: 'aq11',
  title: '子进程的可执行路径写死（干净检出时零输出）',
  invariants: ['INV-CORE-20'],
  code: 'AQ011_HARDCODED_TOOL_PATH',
  blindSpots: [
    '只判「与本文件内的子进程调用同语句」的形态：路径传给别的模块、再由那个模块 spawn，跨文件不可见',
    '`process.env` / 配置项 / 命令行参数带来的路径不在射程（那些本来就是运行时解析）',
    '`argv[1]` 只判「命令位」：作为参数传给解释器（`npx tsx argv[1]`）是跑自己的正确写法，不报；先取变量再传给命令位的写法会漏',
    '`exec()` 的整串命令（`exec(\`node ${argv[1]}\`)`）里位置信息丢失，按命令位处理，属已知误报面',
    '不判「路径是否真的指向 CLI」：`node_modules/.bin/x` 与 `node_modules/x/dist/cli.js` 同等对待',
    '依赖目录名是配置项（`deps`）：换用 pnpm 的 `.pnpm` 深层路径、或 vendor 目录名不同的工程需自行配置',
    '判据不知道运行时是否真的有该目录，故它对「本地已装依赖」的工程也只按形态报——修法是从根向上逐级找，不是加豁免',
  ],
  impact:
    '干净 checkout（worktree / CI 浅克隆）里没有 node_modules：写死的 CLI 路径不存在 ⇒ 子进程零输出 ⇒ 常被误读成「被测代码抛穿了」，探针结论缺失与真实缺陷混为一谈',
  provenance:
    '试点 C（2026-10）：同一批内两次栽在「夹具取 CLI 路径」上——先是写死 node_modules 绝对路径（worktree 里零输出被读成被测代码异常），修法第一版又假设 process.argv[1] 是运行时 CLI（实际是被重写后的脚本路径）',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    if (!SPAWN_CALL.test(code)) return []

    const lines = code.split('\n')
    const spawnLines = new Set<number>()
    lines.forEach((line, i) => {
      if (SPAWN_CALL.test(line)) spawnLines.add(i + 1)
    })

    /** 该变量名是否出现在某条子进程调用行里 */
    const usedBySpawn = (name: string): number | null => {
      const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`)
      for (const ln of spawnLines) if (re.test(lines[ln - 1])) return ln
      return null
    }

    const hits: RawHit[] = []

    DEP_LITERAL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DEP_LITERAL.exec(code)) !== null) {
      const at = m.index
      const line = lineOf(src, at)
      const text = m[2]

      if (spawnLines.has(line)) {
        hits.push({
          line,
          message:
            `子进程的可执行路径写死依赖目录（\`${text}\`）：干净 checkout（worktree / CI 浅克隆）里该路径不存在，` +
            '子进程要么直接 ENOENT 抛错、要么零输出退出后被记成「被测对象失败」；改为从仓库根向上逐级查找，找不到要显式抛错',
          evidence: evidenceOf(src, at),
        })
        continue
      }

      const decl = VAR_DECL.exec(lines[line - 1] ?? '')
      if (!decl) continue
      const spawnLine = usedBySpawn(decl[1])
      if (spawnLine === null) continue
      hits.push({
        line,
        message:
          `\`${decl[1]}\` 取自写死的依赖目录（\`${text}\`），第 ${spawnLine} 行把它交给子进程：` +
          '干净 checkout 里该路径不存在，子进程会零输出退出，而结论会被记成被测对象的失败',
        evidence: evidenceOf(src, at),
      })
    }

    // argv[1] 的命中位置按**它在 code 里的真实下标**算：行首偏移是近似值，
    // 一行里出现两次 argv[1] 时会把证据指到错误的位置（错位的行号比没有行号更贵）。
    const argvRe = new RegExp(ARGV1.source, 'g')
    let argvHit: RegExpExecArray | null
    while ((argvHit = argvRe.exec(code)) !== null) {
      const at = argvHit.index
      const line = lineOf(src, at)
      if (!spawnLines.has(line)) continue
      if (!inCommandPosition(code, at)) continue
      hits.push({
        line,
        message:
          '把 `process.argv[1]` 放在子进程的**命令位**：它是被执行的脚本路径，不是解释器；' +
          '这样等于把入口文件当可执行程序启动。运行时要从 `process.execPath` 取，CLI 要从显式解析的路径取',
        evidence: evidenceOf(src, at),
      })
    }

    return hits
  },
  fixtures: [
    {
      name: '写死 node_modules 并直接 spawn（该报）',
      expect: 'red',
      src: "import { spawnSync } from 'node:child_process'\nconst cli = path.join(root, 'node_modules/tsx/dist/cli.mjs')\nspawnSync(process.execPath, [cli, 'probe.ts'])\n",
    },
    {
      name: '分段 path.join（该报）：`node_modules` 是独立字符串段',
      expect: 'red',
      src: "const cli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')\nexecFileSync(cli, ['--version'])\n",
    },
    {
      name: '内联在实参里（该报）',
      expect: 'red',
      src: "spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'a.ts'])\n",
    },
    {
      name: 'process.argv[1] 当 CLI（该报）',
      expect: 'red',
      src: "import { spawnSync } from 'node:child_process'\nspawnSync(process.argv[1], ['--version'])\n",
    },
    {
      name: 'argv[1] 当参数、命令是 npx（不该报）：这是「跑自己这个脚本」的正确写法',
      expect: 'green',
      src: "import { spawnSync } from 'node:child_process'\nspawnSync('npx', ['tsx', path.resolve(process.argv[1]), '--digest'], { shell: true })\n",
    },
    {
      name: 'require.resolve 解析（不该报）：路径由运行时给',
      expect: 'green',
      src: "const cli = require.resolve('tsx/cli')\nspawnSync(process.execPath, [cli, 'probe.ts'])\n",
    },
    {
      name: '安装提示文案里提到 node_modules（不该报）：与 spawn 不同语句',
      expect: 'green',
      src: "if (!existsSync(p)) console.log('请先安装依赖：node_modules 不存在时子进程会零输出')\nspawnSync('git', ['status'])\n",
    },
    {
      name: '注释里的写死路径（不该报）：去注释先于判定',
      expect: 'green',
      src: "// 旧写法：spawnSync('node', ['node_modules/tsx/dist/cli.mjs'])\nspawnSync('git', ['status'])\n",
    },
    {
      name: '只打印路径、不跑子进程（不该报）：没有子进程调用时本规则整体不适用',
      expect: 'green',
      src: "console.log(path.join(root, 'node_modules/tsx/dist/cli.mjs'))\n",
    },
    {
      name: '变量同文件但没交给子进程（不该报）',
      expect: 'green',
      src: "const dir = path.join(root, 'node_modules/tsx')\nconsole.log(dir)\nspawnSync('git', ['status'])\n",
    },
  ],
})
