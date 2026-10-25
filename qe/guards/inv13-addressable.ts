import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { DEFECT_CLASSES } from '../registry/types.ts'
import { readTextSafe, rel, walkFiles } from '../lib/fs.ts'
import { maskRegexBodies, maskStringBodies, parenBody, stripComments } from '../lib/code-only.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import type { Invariant } from '../registry/types.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv13-addressable')

/** 用例共用的 registry：只关心「别名必须在 package.json 里」这一条，不参与其它分组 */
const REG = (): Invariant[] => [
  {
    id: 'INV-T-01',
    statement: '测试条目：守卫别名必须可寻址',
    defectClasses: ['登记制失效'],
    guard: 'qe:ok',
    badSample: 'fixture',
    status: 'enforced',
  },
]


const SCRIPT_FILE = /(?:^|[\s&|])(?:node|tsx|ts-node|bun)\s+(?:--[\w-]+\s+)*([^\s"'&|]+\.(?:ts|js|mjs|cjs))/g
/**
 * `node <runner.mjs> <script.ts>` 是 TS 仓库最常见的入口形态（pnpm 的 tsx 入口就是
 * `node node_modules/tsx/dist/cli.mjs scripts/x.ts`）。`SCRIPT_FILE` 只取 `node` 后**第一个**
 * 路径 token，于是把 runner 本身当成被测脚本，链尾真正的脚本永远接不上入口 —— 实测
 * 外部试点仓的 `verify:data-dictionary` 明明有别名，`scripts/verify-data-dictionary.ts` 仍被判孤儿
 * （89/144 条假红的根因）。这里补一条**只用于播种、不参与存在性校验**的入口通道：
 * 把命令里所有脚本扩展名 token 都算作「被提到」，避免 runner 之前的那一个独占入口。
 */
const SCRIPT_TOKEN = /[^\s"'&|]+\.(?:ts|tsx|js|mjs|cjs|mts|cts)/g
const NODE_MODULES_TOKEN = /(^|\/)node_modules\//
/**
 * 编排层里的脚本提及：不带 `node` 前缀也要认（`bash run.sh`、`sh -c 'x.mjs'`、变量拼接）。
 * 尾随 `(?![A-Za-z0-9_])` 不可省：没有它 `package.json` 会被截成 `package.js` 命中。
 */
const SCRIPT_REF = /([A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs))(?![A-Za-z0-9_])/g

/** 只剥整行注释：行尾 `#` 在 shell 里可能落在引号内，剥错会把真实调用一起吃掉 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((l) => (/^\s*#/.test(l) ? '' : l))
    .join('\n')
}

/**
 * 脚本之间的 import/require（含动态 import 与侧效应 import）。**这是第三种入口**：
 * 由 runner 引入的 helper 没有也不需要 package.json 入口，只看 package.json 的判据会把它判成孤儿。
 *
 * `import\s+` 这一支不能省：`import './instrument'` 是纯侧效应写法，没有 `from`，
 * 漏掉它就会把「被 injection 的模块」全判成孤儿（夹具 chain 就是照这个反证建的）。
 */
const IMPORT_SPEC = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g
const SCRIPT_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts']

/**
 * **第四种入口**：拼接路径喂子进程 —— `join(ROOT, 'scripts', 'fixtures', 'x.ts')`。
 *
 * 实测形态（`scripts/smoke-tridomain-p2.ts:330`）：env 固化在模块常量里，只能换进程跑，
 * 于是路径由 `join()` 拼出来、变量在中间，import 图完全看不到。只看字面 import 的判据
 * 会把这类夹具全判成孤儿 —— 而它们恰恰是「唯一能证明该走的轨没被 mock 掉」的那部分。
 *
 * 只认 `join/resolve(...)` 里的**连续字面量段**，不认「文件里提了一句」：
 * 「提及 ≠ 会跑」在本仓已经栽过一次（注释里提到某脚本即被认领成功）。
 * 注释在 parse 前已被 stripComments 剥掉，所以注释里的 join 不会算数。
 */
// 前一个字符不能是 `.`：否则 `arr.join('|')` 这类数组拼接会被当路径
const JOIN_CALL = /(?:^|[^\w$.])(?:path\.(?:posix\.)?)?(?:join|resolve)\s*\(/g
const STR_LIT = /['"]([^'"]*)['"]/g

/** 从 `join(a, 'x', 'y.ts')` 里取出字面量段，返回所有连续后缀（`x/y.ts`、`y.ts`）候选仓库相对路径 */
function joinCandidates(args: string, known: Set<string>): string[] {
  const lits: string[] = []
  STR_LIT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STR_LIT.exec(args)) !== null) lits.push(m[1])
  const out: string[] = []
  for (let i = 0; i < lits.length; i++) {
    const cand = path.posix.normalize(lits.slice(i).join('/').replace(/^\/+/, ''))
    if (!SCRIPT_EXTS.some((x) => cand.endsWith(x))) continue
    if (known.has(cand)) out.push(cand)
  }
  return out
}

/**
 * 极简 glob → RegExp：`**` 跨目录、`*` 不跨 `/`、`?` 单字符。
 *
 * 不用 `path.matchesGlob`：它是实验 API，且语义随 Node 版本变。判据的判定面必须自己说了算，
 * 否则换个 Node 版本读数就变 —— 这正是 ratchet 最怕的事。
 */
function globToRe(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

const execFileAsync = promisify(execFile)

/**
 * `scriptsDirs` 下**被 git 跟踪**的脚本（仓库相对路径）。返回 null = 不是 git 仓库/git 不可用。
 *
 * 为什么必须按跟踪过滤：磁盘上的 `scripts/tmp-*.ts`、`scripts/dev/*demo.js` 这类本地草稿
 * 提交不了，却也「没有入口」。把它们算进读数会让同一条判据在别人机器上、在干净 clone 上
 * 给出不同数字 —— 基线不可复现，ratchet 比的就不是同一个东西。
 * 「判据对象必须是能被提交的东西」这条纪律在这里的落地就是这一步。
 */
async function gitTrackedScripts(root: string, dirs: string[], ignore: string[]): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', ...dirs], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    })
    const set = new Set<string>()
    for (const f of stdout.split('\0')) {
      if (!f) continue
      const n = f.replace(/\\/g, '/')
      if (!SCRIPT_EXTS.some((x) => n.endsWith(x))) continue
      if (ignore.some((rule) => {
        const clean = rule.replace(/\/+$/, '')
        return n === clean || n.startsWith(`${clean}/`) || n.split('/').includes(clean)
      })) continue
      set.add(n)
    }
    return set
  } catch {
    return null
  }
}

/**
 * 把相对 specifier 解析成仓库相对的脚本路径。只解析 `./`、`../`：裸包名走 node_modules，与「有没有人跑」无关。
 * 候选顺序按 TS 约定：原样 → 补扩展名 → 目录 index；`.js` 写法回退到同名 `.ts`（Node16 风格的导入）。
 */
function resolveSpec(fromRel: string, spec: string, known: Set<string>): string[] {
  if (!spec.startsWith('.')) return []
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  const out = [base]
  const jsLike = /\.(js|mjs|cjs)$/.exec(base)
  if (jsLike) out.push(base.slice(0, -jsLike[0].length) + '.ts')
  for (const ext of SCRIPT_EXTS) out.push(`${base}${ext}`)
  for (const ext of SCRIPT_EXTS) out.push(`${base}/index${ext}`)
  return out.filter((c) => known.has(c))
}

export const inv13 = defineGuard({
  id: 'inv13-addressable',
  title: '守卫在册必须被跑到（入口/别名/坏样本/复审）',
  invariants: ['INV-CORE-13'],
  blindSpots: [
    '只校验 npm 别名的「存在性」，不校验它是否在 CI 中被调用',
    '不解析 shell 管道与嵌套引号，复杂命令可能漏检',
    'registry 是 TS 模块，本守卫读到的是运行时加载结果，不校验源文件格式',
    '编排层引用只认字面路径 token：`cd` 换目录后再用裸文件名、变量拼接（`$DIR/x.mjs`）都认不出',
    'import 边只认同文件内字面 specifier：路径别名（`@/x`）、tsconfig paths、monorepo workspace 都认不出（那几个方向会误报成孤儿，不是漏报）',
    '可达性只覆盖 `scriptsDirs` 内的文件：scripts 里 import `lib/x.ts` 时，lib 侧不参与本判据',
    '`addressableLibDirs` 是按目录声明的豁免，声明过宽会把真孤儿一起跳掉（读数里 lib 跳过数必须可对账）',
  ],
  async run(ctx) {
    /**
     * 一条判据两个问题，适用条件不同，**必须分开判**：
     *   A. registry 面（别名/坏样本/复审）：只在「这个仓自己带引擎 registry」时成立；
     *   B. addressable 面（脚本/守卫有无入口）：任何有 package.json 的仓都成立。
     *
     * 合成一个开关的后果实测过：审外部仓时把引擎自己的 `INV-CORE-*` 拿去对它家的
     * `package.json` 断言，47 条 `ALIAS_MISSING` 全是类别错误；而为了压掉它们，
     * 配置里只好把**整个守卫**降级成 warn —— 连带把真正的 `SCRIPT_TARGET_MISSING` 也一起放过。
     * 「一项不适用就整条不判」正是「撤了一半」的近亲。
     */
    const registryApplicable = ctx.config.metaGuards !== false && ctx.registry.length > 0
    const pkgText = await readTextSafe(path.join(ctx.root, ctx.config.packageJson))
    if (pkgText === null && !registryApplicable) {
      throw new NotApplicable('NOTHING_ADDRESSABLE', '既没有引擎 registry、也没有 package.json：没有可寻址的对象')
    }
    if (pkgText === null) {
      return {
        findings: [err('PACKAGE_MISSING', `package.json 未找到：${ctx.config.packageJson}`, { file: ctx.config.packageJson })],
        scanned: 'scripts=0 registry=0',
      }
    }
    let scripts: Record<string, string>
    try {
      scripts = (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch (e) {
      return {
        findings: [err('PACKAGE_BAD', `package.json 解析失败：${(e as Error).message}`, { file: ctx.config.packageJson })],
        scanned: 'scripts=0 registry=0',
      }
    }
    const findings = []
    const now = Date.now()

    for (const inv of registryApplicable ? ctx.registry : []) {
      if (inv.defectClasses.length === 0 || inv.defectClasses.some((c) => !DEFECT_CLASSES.includes(c))) {
        findings.push(err('BAD_DEFECT_CLASS', `${inv.id} 的 defectClasses 未归一到 58 号九类（禁止发明第十类）`, { entity: inv.id }))
      }
      if (inv.status === 'enforced' || inv.status === 'partial') {
        if (!inv.guard) findings.push(err('REGISTRY_NO_GUARD', `${inv.id} 标 ${inv.status} 但未登记守卫别名`, { entity: inv.id }))
        else if (!(inv.guard in scripts)) {
          findings.push(err('ALIAS_MISSING', `${inv.id} 的守卫别名 ${inv.guard} 不在 package.json scripts（在册但跑不到）`, { entity: inv.id }))
        }
      }
      if (inv.status === 'enforced' && !inv.badSample) {
        findings.push(err('REGISTRY_NO_BAD_SAMPLE', `${inv.id} 标 enforced 但无坏样本（缺反证不许标在位）`, { entity: inv.id }))
      }
      if (inv.status === 'partial' && !inv.gap) {
        findings.push(err('REGISTRY_NO_GAP', `${inv.id} 标 partial 但未写缺口`, { entity: inv.id }))
      }
      if (inv.status === 'open') {
        if (!inv.openReason || !inv.revisitBy) {
          findings.push(err('REGISTRY_OPEN_UNTRIAGED', `${inv.id} 标 open 但缺理由或复审触发器（无账即红）`, { entity: inv.id }))
        } else if (Date.parse(inv.revisitBy) < now) {
          findings.push(err('REVISIT_OVERDUE', `${inv.id} 的复审日期 ${inv.revisitBy} 已过，未处理转红`, { entity: inv.id }))
        }
      }
    }

    const referenced = new Set<string>()
    /**
     * runner 链路里的脚本（`node <runner.mjs> <script.ts>`）。
     * 与 `referenced` 分开存：这一支**只播种、不做存在性校验**，否则命令里任何带脚本扩展名的
     * 参数（glob、临时产物路径）都会被记成 `SCRIPT_TARGET_MISSING`。
     */
    const mentioned = new Set<string>()
    for (const [name, command] of Object.entries(scripts)) {
      SCRIPT_FILE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SCRIPT_FILE.exec(command)) !== null) {
        const target = m[1]
        // `node node_modules/tsx/dist/cli.mjs …` 里的 runner 是**依赖**，不是被测仓的脚本：
        // 它的存在性取决于有没有装依赖，与「这个脚本有没有人跑」无关。把它算进存在性校验，
        // 干净 clone 未 install 时整仓别名全红 —— 判据就不可复现了。runner 之后真正的脚本
        // 由下面的 SCRIPT_TOKEN 通道补齐。
        if (NODE_MODULES_TOKEN.test(target.replace(/\\/g, '/'))) continue
        referenced.add(target)
        referenced.add(path.normalize(target))
        const text = await readTextSafe(path.join(ctx.root, target))
        if (text === null) {
          findings.push(err('SCRIPT_TARGET_MISSING', `${name} 指向不存在的文件 ${target}`, { file: target }))
        }
      }
      // 补齐 runner 之后被漏掉的那个脚本；`node_modules` 里的 runner 本身是工具不是被测对象
      SCRIPT_TOKEN.lastIndex = 0
      while ((m = SCRIPT_TOKEN.exec(command)) !== null) {
        const token = m[0].replace(/\\/g, '/').replace(/^\.\//, '')
        if (NODE_MODULES_TOKEN.test(token)) continue
        mentioned.add(token)
        mentioned.add(path.posix.normalize(token))
      }
    }

    // 编排层（默认 .sh）里的调用同样算入口：备份/部署链没有也不用 package.json 入口。
    // 两种解析都收：仓库相对（`node scripts/backup/x.mjs`）与编排文件相对（`cd scripts/backup && node x.mjs`）。
    const orchestratorRefs = new Set<string>()
    const orchestratorFiles =
      ctx.config.addressableOrchestratorExts.length === 0
        ? []
        : await walkFiles(ctx.root, '.', { ignore: ctx.config.ignore, ext: ctx.config.addressableOrchestratorExts })
    for (const file of orchestratorFiles) {
      const text = await readTextSafe(file)
      if (text === null) continue
      const body = stripLineComments(text)
      const dir = path.posix.dirname(rel(ctx.root, file))
      SCRIPT_REF.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SCRIPT_REF.exec(body)) !== null) {
        const token = m[1].replace(/\\/g, '/').replace(/^\.\//, '')
        orchestratorRefs.add(token)
        orchestratorRefs.add(path.posix.normalize(path.posix.join(dir, token)))
      }
    }

    const libDirs = ctx.config.addressableLibDirs.map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''))

    const walked: string[] = []
    for (const dir of ctx.config.scriptsDirs) {
      walked.push(...(await walkFiles(ctx.root, dir, { ignore: ctx.config.ignore, ext: SCRIPT_EXTS })))
    }
    // 只判「能被提交的东西」：未跟踪的本地草稿连 clone 之后都不存在，把它们算进读数等于让基线不可复现
    const tracked = ctx.config.addressableTrackedOnly
      ? await gitTrackedScripts(ctx.root, ctx.config.scriptsDirs, ctx.config.ignore)
      : null
    const allRels = walked.map((f) => rel(ctx.root, f)).sort()
    const untracked = tracked === null ? [] : allRels.filter((r) => !tracked.has(r))
    const scriptFiles = new Set(tracked === null ? allRels : allRels.filter((r) => tracked.has(r)))

    // 依赖图：脚本 → 它 import 进来的脚本。剥掉注释，避免被注释里的 import 喂成「有入口」。
    const deps = new Map<string, string[]>()
    for (const r of scriptFiles) {
      const text = await readTextSafe(path.join(ctx.root, r))
      if (text === null) {
        deps.set(r, [])
        continue
      }
      const body = stripComments(text)
      const list: string[] = []
      IMPORT_SPEC.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = IMPORT_SPEC.exec(body)) !== null) list.push(...resolveSpec(r, m[1], scriptFiles))
      // 实参按括号配对取（`join(process.cwd(), 'scripts', 'x.ts')` 里有嵌套圆括号，
      // 正则 `[^()]*` 会在这里静默截断），定位在掩过字符串/正则的文本上做、取值回到剥注释后的原文
      const masked = maskRegexBodies(maskStringBodies(body))
      JOIN_CALL.lastIndex = 0
      while ((m = JOIN_CALL.exec(masked)) !== null) {
        const args = parenBody(body, m.index + m[0].length - 1)
        if (args !== null) list.push(...joinCandidates(args, scriptFiles))
      }
      deps.set(r, list)
    }

    // 动态发现：项目声明的「runner 会扫这一类文件」，理由必填、命中数进读数。
    // **它同时是种子** —— 发现制里的文件真的会被执行，它们 import/join 出去的东西也就有线。
    // 只把它当「报不报」的开关（不喂进图）会漏掉一整层：被 smoke-*.ts 用 `join()` 拼出来的夹具
    // 仍然算孤儿（实测：ps-mock-track-probe.ts）。
    const discovery = ctx.config.addressableDiscovery.map((d) => ({ ...d, re: globToRe(d.glob), hits: 0 }))
    for (const d of discovery) {
      if (d.reason.trim().length === 0) {
        findings.push(err('DISCOVERY_NO_REASON', `动态发现声明 ${d.glob} 没写理由（空理由＝把豁免槽换个名字）`, { file: d.glob }))
      }
    }

    // 人工类：按需由人执行的脚本（取证工具 / 反证发生器 / 一次性作业）。
    //
    // 与发现制吃同样的两道：理由必填、幽灵 glob 判红；外加第三道 —— `howToRun` 必须能在
    // **文件自身**里找到。这一条把豁免反转成举证：有入口的脚本，证据是 package.json 里那一行；
    // 声明成人工类的脚本，证据得是它自己写着怎么跑。没有这道，人工类就是白名单
    // （谁都能加一条 glob 让孤儿消失），而白名单正是让「136 条里 112 条假阳性」发生的东西。
    const manual = ctx.config.addressableManualClasses.map((d) => ({
      ...d,
      re: globToRe(d.glob),
      hits: 0,
      hitFiles: [] as string[],
    }))
    for (const d of manual) {
      if (d.reason.trim().length === 0) {
        findings.push(err('MANUAL_CLASS_NO_REASON', `人工类声明 ${d.glob} 没写理由（空理由＝把豁免槽换个名字）`, { file: d.glob }))
      }
      if (d.howToRun.trim().length === 0) {
        findings.push(
          err('MANUAL_CLASS_NO_RUNBOOK_DECL', `人工类声明 ${d.glob} 没给 howToRun（没有运行路径的人工类＝没人能跑的死代码）`, { file: d.glob }),
        )
      }
    }

    // 种子＝真入口（package.json ∨ 编排层 ∨ 动态发现），随后取传递闭包：被入口 import/join 的 helper 也算接上了线。
    const reachable = new Set<string>()
    const queue: string[] = []
    for (const spec of [...referenced, ...mentioned, ...orchestratorRefs]) {
      const n = path.posix.normalize(spec.replace(/\\/g, '/'))
      if (scriptFiles.has(n)) queue.push(n)
    }
    for (const r of scriptFiles) {
      const discovered = discovery.find((d) => d.re.test(r))
      if (discovered) {
        discovered.hits++
        queue.push(r)
      }
      // 人工类同样是种子：人会按说明去跑它，它 import/join 出去的也算有线。
      const byHuman = manual.find((d) => d.re.test(r))
      if (byHuman) {
        byHuman.hits++
        byHuman.hitFiles.push(r)
        queue.push(r)
      }
    }

    // 举证校验：`howToRun` 是**前缀**，拼上每个命中文件自己的路径，那条命令必须能在文件里找到。
    //
    // 为什么不写完整命令：一批工具共用同一个运行器和目录，只有后半段不同。写成完整命令
    // 就退化成「一个 glob 对一个文件」，声明区会胀成一整份白名单（夹具一写就暴露了这个）。
    //
    // 校验失败形态是「被白名单藏起来的孤儿」：读数上它已从清单里消失，但它仍然没人能跑。
    for (const d of manual) {
      const prefix = d.howToRun.trim()
      if (prefix.length === 0) continue // 已在上面判过
      // 拼之前补分隔符：`howToRun: 'tsx '` trim 之后是 `tsx`，直接拼会得到 `tsxscripts/...`，
      // 于是**声明得完全正确也被判红**。判据自己的拼接错误不许记成被检对象的缺陷。
      const glued = prefix.endsWith('/') || prefix.endsWith(' ') ? prefix : `${prefix} `
      for (const r of d.hitFiles) {
        const body = await readTextSafe(path.join(ctx.root, r))
        if (body === null) continue
        const cmd = `${glued}${r}`
        if (!body.includes(cmd)) {
          findings.push(
            warn(
              'MANUAL_CLASS_NO_RUNBOOK',
              `${r} 被声明为人工类，但文件里找不到运行说明 ${JSON.stringify(cmd)}（没人知道怎么跑＝真孤儿换了个名字）`,
              { file: r },
            ),
          )
        }
      }
    }
    while (queue.length > 0) {
      const cur = queue.pop() as string
      if (reachable.has(cur)) continue
      reachable.add(cur)
      for (const d of deps.get(cur) ?? []) if (!reachable.has(d)) queue.push(d)
    }

    let libSkipped = 0
    const orphans: string[] = []
    for (const r of [...scriptFiles].sort()) {
      // 库目录的正常状态就是「没有入口」——它由调用方进入。不声明这层，真孤儿会被 lib 噪声淹没。
      if (libDirs.some((d) => r === d || r.startsWith(`${d}/`))) {
        libSkipped++
        continue
      }
      if (!reachable.has(r)) orphans.push(r)
    }
    for (const d of discovery) {
      if (d.hits === 0) {
        findings.push(
          err('DISCOVERY_GLOB_GHOST', `动态发现声明 ${d.glob} 一个文件都没命中（幽灵模式＝永久空豁免槽，必须删掉）`, { file: d.glob }),
        )
      }
    }
    for (const d of manual) {
      if (d.hits === 0) {
        findings.push(
          err('MANUAL_CLASS_GLOB_GHOST', `人工类声明 ${d.glob} 一个文件都没命中（幽灵模式＝永久空豁免槽，必须删掉）`, { file: d.glob }),
        )
      }
    }
    for (const r of orphans) {
      findings.push(
        warn('UNWIRED_SCRIPT', `${r} 在盘无入口（五条路都未接上：package.json 别名 / 编排层引用 / 被其他脚本 import / join() 拼给子进程 / runner 发现制或人工类声明）`, { file: r }),
      )
    }
    if (untracked.length > 0) {
      findings.push(
        info(
          'UNTRACKED_SKIPPED',
          `${untracked.length} 个未跟踪脚本不参与判定（提交不了的东西不进读数，否则同一条判据在干净 clone 上数字不同）：${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? ' …' : ''}`,
        ),
      )
    }

    const guardFiles = await walkFiles(ctx.root, ctx.config.guardsDir, { ignore: ctx.config.ignore, ext: ['.ts'] })
    const indexText = (await readTextSafe(path.join(ctx.root, ctx.config.guardsDir, 'index.ts'))) ?? ''
    for (const file of guardFiles) {
      const base = path.basename(file)
      if (base === 'index.ts') continue
      if (!indexText.includes(base)) {
        findings.push(warn('ORPHAN_GUARD', `${rel(ctx.root, file)} 未被 ${ctx.config.guardsDir}/index.ts 引用`, { file: rel(ctx.root, file) }))
      }
    }

    if (findings.length === 0) {
      const regNote = registryApplicable ? `registry ${ctx.registry.length} 条` : 'registry 面不适用（本项目未带引擎 registry）'
      findings.push(info('ADDRESSABLE_CLEAN', `${regNote}、别名 ${Object.keys(scripts).length} 个，全部可寻址`))
    }
    const untrackedNote = !ctx.config.addressableTrackedOnly
      ? '；按配置关闭未跟踪过滤'
      : tracked === null
        ? '；⚠ git 不可用，未跟踪过滤未生效'
        : ''
    return {
      findings,
      scanned: `registry=${registryApplicable ? ctx.registry.length : 0}${registryApplicable ? '' : '(面不适用)'} scripts=${Object.keys(scripts).length} scriptFiles=${scriptFiles.size}（库目录 ${libSkipped} 条不参与入口判定，未跟踪 ${untracked.length} 条已排除${untrackedNote}；动态发现 ${discovery.map((d) => `${d.glob}=${d.hits}`).join(',') || '无'}；人工类 ${manual.map((d) => `${d.glob}=${d.hits}`).join(',') || '无'}） orchestrator=${orchestratorFiles.length} orchRefs=${orchestratorRefs.size} reachable=${reachable.size} guardFiles=${guardFiles.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：别名可寻址、无孤儿脚本',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      // 夹具不是被跟踪的文件（引擎内部样本），所以显式关掉「只判 git 跟踪」这一层
      config: { packageJson: 'package.json', guardsDir: 'guards', scriptsDirs: ['scripts'], addressableTrackedOnly: false },
      registry: REG(),
    },
    {
      name: 'bad：别名指向缺失文件 + 孤儿脚本/守卫',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      minWarnings: 2,
      // 夹具不是被跟踪的文件（引擎内部样本），所以显式关掉「只判 git 跟踪」这一层
      config: { packageJson: 'package.json', guardsDir: 'guards', scriptsDirs: ['scripts'], addressableTrackedOnly: false },
      registry: [
        {
          id: 'INV-T-01',
          statement: '测试条目：守卫别名必须可寻址',
          defectClasses: ['登记制失效'],
          guard: 'qe:bad',
          badSample: 'fixture',
          status: 'enforced',
        },
      ],
    },
    {
      // 射程锁定：库目录 + 编排层两条豁免都要生效 ⇒ 只剩真孤儿（orphan.ts / 注释里那个 legacy.mjs）
      name: 'warn：库目录与编排层引用都算入口，只剩真孤儿',
      root: path.join(FIXTURES, 'orch'),
      expect: 'warn',
      minWarnings: 2,
      maxWarnings: 2,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableLibDirs: ['scripts/lib'],
        addressableOrchestratorExts: ['.sh'],
      },
      registry: REG(),
    },
    {
      // 反证：同夹具、关掉两条豁免 ⇒ 读数必须变 4（lib/helper、backup/cos.mjs 都被判成孤儿）。
      // 若谁把豁免改回去或改宽，上一条的 maxWarnings 会先红；这条保证「差异确实来自豁免」而不是夹具本身干净。
      name: 'red-对照组：不配豁免时同一夹具报 4 条（豁免确实在起作用）',
      root: path.join(FIXTURES, 'orch'),
      expect: 'warn',
      minWarnings: 4,
      maxWarnings: 4,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableLibDirs: [],
        addressableOrchestratorExts: [],
      },
      registry: REG(),
    },
    {
      // 传递闭包 + 四种入口：runner.ts 是唯一入口；one/two 靠 import、spawned 靠在 `join()` 的
      // 字面量段里被拼出来。剩下两条只在**注释**里出现（commented 是注释里的 import、
      // dead 是注释里的 join），必须照判孤儿 —— 剥注释这一步要真的生效。
      name: 'warn：import 与 join 拼接都算接上线，只出现在注释里的两条仍判孤儿',
      root: path.join(FIXTURES, 'chain'),
      expect: 'warn',
      minWarnings: 2,
      maxWarnings: 2,
      // 夹具不是被跟踪的文件（引擎内部样本），所以显式关掉「只判 git 跟踪」这一层
      config: { packageJson: 'package.json', guardsDir: 'guards', scriptsDirs: ['scripts'], addressableTrackedOnly: false },
      registry: REG(),
    },
    {
      // runner 链路：`node node_modules/tsx/dist/cli.mjs scripts/ok.ts` 是 TS 仓库最常见的入口形态。
      // SCRIPT_FILE 只认 `node` 后第一个路径 token（这里是 runner 本身），链尾脚本会被漏成孤儿。
      // 同时钉住两条边界：`.mts` 必须在射程内；命令里的 glob 参数（`scripts/*.spec.ts`）
      // 只播种、不做存在性校验 ⇒ 不得冒 SCRIPT_TARGET_MISSING。
      name: 'warn：node <runner> <script> 链尾脚本算入口，.mts 在射程内，glob 参数不判缺失',
      root: path.join(FIXTURES, 'runner'),
      expect: 'warn',
      minErrors: 0,
      maxErrors: 0,
      minWarnings: 1,
      maxWarnings: 1,
      config: { packageJson: 'package.json', guardsDir: 'guards', scriptsDirs: ['scripts'], addressableTrackedOnly: false },
      registry: REG(),
    },
    {
      // 动态发现：`scripts/smoke-*.ts` 由 runner 扫目录入闸 ⇒ 不算孤儿；嵌套目录不在该 glob 射程内，仍要红。
      name: 'warn：声明的动态发现模式算入口，但它不跨目录',
      root: path.join(FIXTURES, 'disc'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableDiscovery: [{ glob: 'scripts/smoke-*.ts', reason: 'run-all-tests 扫 scripts/smoke-*.ts 裸文件自动入闸（夹具模拟）' }],
      },
      registry: REG(),
    },
    {
      // 反证：同夹具不声明发现模式 ⇒ 报 3 条。证明上一条少掉的 2 条确实来自声明，不是夹具本身干净。
      name: 'red-对照组：不声明发现模式时同一夹具报 3 条',
      root: path.join(FIXTURES, 'disc'),
      expect: 'warn',
      minWarnings: 3,
      maxWarnings: 3,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableDiscovery: [],
      },
      registry: REG(),
    },
    {
      // 幽灵模式：声明一个命中不了任何文件的 glob ＝ 永久空豁免槽，必须判红
      name: 'red：动态发现模式一个文件都没命中（幽灵模式）',
      root: path.join(FIXTURES, 'disc'),
      expect: 'red',
      minErrors: 1,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableDiscovery: [{ glob: 'scripts/nope-*.ts', reason: '占位模式，用来说明幽灵类必须判红（本用例断言这一点）' }],
      },
      registry: REG(),
    },
    {
      // 空理由＝把豁免槽换个名字：判红
      name: 'red：动态发现模式没写理由',
      root: path.join(FIXTURES, 'disc'),
      expect: 'red',
      minErrors: 1,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableDiscovery: [{ glob: 'scripts/smoke-*.ts', reason: '   ' }],
      },
      registry: REG(),
    },
    {
      // 反证「两项分开判」：同一 bad 夹具（别名指向 qe:bad，缺 ALIAS_MISSING 的错）在 metaGuards=false 下
      // 必须只剩 addressable 面的 2 条 warn。若哪天有人把两个面重新合成一个开关，这里立刻红。
      name: 'red：metaGuards=false 只关 registry 面，addressable 面照判（错只剩 SCRIPT_TARGET_MISSING）',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      // 夹具里 `qe:bad` 指向不存在的文件 ⇒ ADDRESSABLE 面本来就有 1 条 error；
      // 若 registry 面没被关掉，ALIAS_MISSING 会让它变成 2 条 —— 用上限把差异钉死。
      minErrors: 1,
      maxErrors: 1,
      minWarnings: 2,
      maxWarnings: 2,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        metaGuards: false,
      },
      registry: [
        {
          id: 'INV-T-01',
          statement: '测试条目：守卫别名必须可寻址',
          defectClasses: ['登记制失效'],
          guard: 'qe:bad',
          badSample: 'fixture',
          status: 'enforced',
        },
      ],
    },
    {
      // 人工类：按需由人执行。声明的 howToRun 必须能在文件里找到 ——
      // probe.ts 头注写着运行命令（算证据），silent.ts 只有目的没有命令（仍要红）。
      // 这条用例钉住的正是「人工类不是白名单，是运行路径声明」。
      name: 'warn：人工类声明的 howToRun 必须在文件里找得到，找不到的仍算孤儿',
      root: path.join(FIXTURES, 'manual'),
      expect: 'warn',
      minErrors: 0,
      maxErrors: 0,
      minWarnings: 1,
      maxWarnings: 1,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableManualClasses: [
          {
            glob: 'scripts/dev/*.ts',
            // 前缀 + 文件自己的路径 = 逐文件落地校验：probe.ts 里有这一行，silent.ts 没有
            howToRun: 'tsx ',
            reason: '取证/反证工具，按需人工执行，正常状态就没有 package.json 别名（夹具模拟）',
          },
        ],
      },
      registry: REG(),
    },
    {
      // 反证：同夹具不声明人工类 ⇒ 2 条孤儿。证明上一条少掉的那 1 条确实来自声明，
      // 而且声明并没有把 silent.ts 一起放过（它只是从 UNWIRED_SCRIPT 变成 NO_RUNBOOK）。
      name: 'red-对照组：不声明人工类时同一夹具报 2 条孤儿',
      root: path.join(FIXTURES, 'manual'),
      expect: 'warn',
      minWarnings: 2,
      maxWarnings: 2,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableManualClasses: [],
      },
      registry: REG(),
    },
    {
      // 幽灵人工类＝永久空豁免槽：一个文件都没命中的 glob 必须判红，否则删掉 git 里那些
      // 「已退役」的脚本后，它们的豁免槽会原地留着，下一个同名文件自动继承豁免。
      name: 'red：人工类 glob 一个文件都没命中（永久空豁免槽）',
      root: path.join(FIXTURES, 'manual'),
      expect: 'red',
      minErrors: 1,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableManualClasses: [
          { glob: 'scripts/retired-*.ts', howToRun: 'tsx scripts/retired-x.ts', reason: '占位' },
        ],
      },
      registry: REG(),
    },
    {
      // 没有 howToRun 的人工类＝没人能跑的死代码，只是把它从清单上抹掉了。判红。
      name: 'red：人工类没给 howToRun（豁免不等于有运行路径）',
      root: path.join(FIXTURES, 'manual'),
      expect: 'red',
      minErrors: 1,
      config: {
        packageJson: 'package.json',
        guardsDir: 'guards',
        scriptsDirs: ['scripts'],
        addressableTrackedOnly: false,
        addressableManualClasses: [{ glob: 'scripts/dev/*.ts', howToRun: '  ', reason: '故意留空以断言本项判红' }],
      },
      registry: REG(),
    },
  ],
})
