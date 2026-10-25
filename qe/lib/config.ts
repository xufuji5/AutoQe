import path from 'node:path'
import { readFile } from 'node:fs/promises'

export interface BoundaryConfig {
  authPatterns: string[]
  validatePatterns: string[]
  mutationMethods: string[]
  /**
   * 公共路由登记。`methods` 缺省=整文件公开；填写后只放开列出的方法。
   * 同一文件既有匿名面（如能力发现 GET）又有鉴权面（如 MCP POST）时必须写 `methods`，
   * 否则会把整文件免检，鉴权面的覆盖一并丢失。
   */
  publicRoutes: { file: string; reason: string; methods?: string[] }[]
}

export interface StoreConfig {
  moduleRoots: string[]
  sensitiveKeys: string[]
}

/**
 * 规格对账配置（AQ-ABS：缺失族）。
 *
 * 这里的 oracle 是**文档库**：文档承诺了模型/字段/端点，代码里没有 → 缺失型缺陷。
 * 但文档会过期，所以本守卫默认只出候选（warn）；只有显式声明 `docsOwner`
 * （谁负责让文档跟上代码、怎么跟）时才允许 `enforce: true` 升级为 error。
 * 没有 owner 就升级 = 拿一把没人校准的尺子量人。
 */
export interface SpecConfig {
  /** 文档目录（相对 root）；空 = 未配置，守卫显式跳过（不报绿） */
  docs: string[]
  /** 文档扩展名，默认 ['.md'] */
  extensions?: string[]
  /** Next.js 路由根，默认 ['src/app', 'app'] */
  routeRoots?: string[]
  /** 是否把缺口升级为 error。默认 false */
  enforce?: boolean
  /** enforce 必填：谁负责文档与实现同步（人/流程），没写不许升级 */
  docsOwner?: string
}

/**
 * 界面入口覆盖配置（inv23：服务端有、界面无入口）。
 *
 * 判据的 oracle 是**界面语料**：写方法端点必须在 `uiRoots` 里找到真实请求发送点。
 * 找不到的只有两种正当解释：外部渠道（网关/扫码器/监管系统直连）或工期档（已登记、有复审日期）。
 * 两者都要逐条写理由 —— 空理由不是豁免，是漏判。
 */
export interface CoverageConfig {
  /** 界面语料根（默认 ['app','components']）；`app/api` 下的路由文件恒排除，避免路由自证 */
  uiRoots?: string[]
  /** 路由根（默认 ['app','src/app']），只认 `<root>/api/**\/route.*` */
  routeRoots?: string[]
  /**
   * 第二个（第三个…）客户端语料：同一产品的其它前端，与默认语料**三样都可能不同**
   * （扩展名 / 请求词表 / 目录）。
   *
   * 为什么不能塞进 `uiRoots`：`uiRoots` 共用 `source.extensions` 与请求词表。小程序页面是
   * `.js`、发请求靠 `wx.request` 或私有封装，塞进 `source.extensions` 会让所有依赖源码面的
   * 判据顺带扫客户端代码——那是拿改判据射程换读数好看。理由必填。
   */
  uiCorpora?: {
    name: string
    roots: string[]
    extensions?: string[]
    /** 该语料的请求发送点正则；缺省沿用默认词表 */
    requestCall?: string
    reason: string
  }[]
  /**
   * 请求发送点词表追加项（正则源码）。理由必填。
   *
   * 默认词表只认识通用名字（fetch/axios/sendBeacon…）。项目自有封装（`apiJson<T>(…)` 这类
   * 带泛型实参、`request({ url })` 这类自研旋钮）不在里面，于是真实入口被判成「用户点不到」。
   * 词表是**项目事实**：由项目声明，判据只负责拼进去 + 拒绝空理由。
   */
  requestCallAdditions?: { pattern: string; reason: string }[]
  /**
   * 动态末段登记：端点末段在调用侧由变量决定（`/api/x/${id}/${action}`），字面量只能证到静态前缀。
   *
   * 这不是豁免，是**举证**：`evidence` 必须指向真实发送点，且其中要能找到
   * `<静态前缀>/${` 这个形态；静态前缀不足 2 段会被判太宽（任何调用都能作证 = 没有判据）。
   * 界面已经能静态命中时登记过期（红）。
   */
  dynamicTail?: { endpoint: string; evidence: string; reason: string }[]
  /** 已登记「服务端有、界面暂无意向入口」的端点；理由与复审日期必填 */
  knownNoEntry?: { route: string; methods?: string[]; reason: string; reviewBy?: string }[]
  /** 外部渠道前缀（网关/脚本/第三方直连）；理由必填 */
  externalPrefixes?: { prefix: string; reason: string }[]
}

/**
 * 软删表读点判据（inv25 / INV-CORE-05）。
 *
 * 登记的每张软删表，其一切读点都要带软删谓词。判据必须知道「哪些表是软删表、
 * 软删列叫什么」，这是**项目事实**，只能由项目声明；未声明时守卫显式跳过（不报绿）。
 */
export interface SoftDeleteConfig {
  /** 软删表（Prisma model 名） */
  tables: string[]
  /** 软删列名，默认 deletedAt */
  column?: string
  /** 全局中间件统一注入软删过滤：理由必填，空理由等同豁免槽 */
  middleware?: { reason: string }
}

/** 错误码册码对拍（inv26 / INV-CORE-10）：正向靠契约台账，反向靠项目声明的抛错形态 */
export interface ErrorCatalogConfig {
  /** 抛错点形态：带一个捕获组的正则，捕获错误码字面量 */
  throwPattern?: string
  /** 反向扫描根（缺省用 source.roots） */
  roots?: string[]
}

/** 干净检出可构建性（inv27 / INV-CORE-14）：构建命令是项目事实，未声明时守卫显式跳过 */
export interface CleanBuildConfig {
  /** 仓级声明的构建命令（在干净 worktree 里以 shell 执行） */
  command: string
  /** 超时秒数，默认 300，clamp 到 [30, 900] */
  timeoutSec?: number
}

/** 变更型入口的速率/体积上限（inv28 / INV-SEC-02）：已登记的限流形态，子串匹配 */
export interface RateLimitConfig {
  /** 已登记的限流/体积上限形态（命中任一即视为覆盖） */
  patterns: string[]
  /** Next.js 路由根（缺省 ['app', 'src/app']），只认其下 api 路由文件 */
  routeRoots?: string[]
}


export interface QeConfig {
  /** schema 来源。provider=none 表示该仓无 schema，依赖 schema 的守卫显式跳过（不报绿） */
  schema: { provider: string; path: string; clientNames: string[] }
  /** 源码采集器。collector=none 表示不采源码（只跑不依赖代码的守卫） */
  source: {
    collector: string
    roots: string[]
    extensions: string[]
    /**
     * 证据目录：只用于「写入者/枚举使用」取证，不作为应用面扫描。
     * 种子、导入、巡检脚本里的写点是真的写点，但不该把脚本里的路由/客户端判据也算进来。
     */
    evidenceRoots?: string[]
  }
  ignore: string[]
  /** 框架托管字段：允许无业务写点，但必须写明理由（理由即审计口径） */
  systemFields: Record<string, string>
  /** 逐字段豁免：理由必填，禁止空理由 */
  fieldExemptions: { model: string; field: string; reason: string }[]
  contracts: string
  scriptsDirs: string[]
  /**
   * `scriptsDirs` 下的**库目录**：被别的脚本 import，本身不该有 package.json 入口。
   *
   * 为什么需要：`UNWIRED_SCRIPT` 的语义是「写了却没人能跑」，而库文件（`scripts/lib/*`）
   * 的正常状态就是「没有入口」——它由调用方进入。不声明这层，判据会把整个 lib 当孤儿，
   * 于是「136 条未接线」里混着 20 条本是正确结构的文件，真孤儿反而被淹没。
   * 精确到目录前缀（`scripts/lib`），不是按文件名猜。
   */
  addressableLibDirs: string[]
  /**
   * 编排层引用来源：以这些扩展名结尾的文件（默认 `.sh`）里提到的脚本路径也算「有入口」。
   *
   * 为什么需要：备份链路 `scripts/backup/db-dump.sh` 用 `node scripts/backup/upload-cos.mjs`
   * 调上传脚本 —— 它**没有也不需要** package.json 入口。只看 package.json 的判据会把它判成孤儿，
   * 而这恰好是「备份到底跑没跑」最容易被误判成没问题的地方（同一误报在 knip 里也出现过一次）。
   * 取扩展名而非 glob：`walkFiles` 只做目录递归，写 glob 只能靠猜，判定面越简单越不会假绿。
   */
  addressableOrchestratorExts: string[]
  /**
   * 只判 git 跟踪的脚本（默认 true）。
   *
   * 磁盘上的本地草稿（`scripts/tmp-*.ts`、`dev/*demo.js`）提交不了，却也「没有入口」。
   * 把它们算进读数，同一条判据在别人机器 / 干净 clone 上会给出不同数字 —— 基线不可复现。
   * 引擎自己的夹具不是被跟踪的文件，所以夹具用例显式关掉本项（关掉必须写在用例里，靠默认值蒙不算）。
   */
  addressableTrackedOnly: boolean
  /**
   * 项目声明的**动态发现**入口：命中 glob 的脚本由「跑测试的那个 runner 扫目录」自动入闸，
   * 因而既不在 `package.json` 里，也不被 import。理由必填（空理由＝豁免槽）。
   *
   * 为什么不能让引擎自己推断：`run-all-tests.ts` 里 `readdirSync(...).filter(/^smoke-.+\.ts$/)`
   * 是运行期行为，静态判据读不出「哪些文件会被它扫到」。而「文件里被提及」又早已被证明是假入口
   * （注释里提一句照样认领成功）。所以只剩两条路：项目自己声明，或者接受噪声。
   * 声明要付代价：每条 glob 必须命中 ≥1 个真实文件（幽灵模式判红），命中数进读数。
   */
  addressableDiscovery: { glob: string; reason: string }[]
  /**
   * 项目声明的**人工类**入口：这些脚本按需由人执行（取证工具、反证发生器、一次性作业），
   * 正常状态就是没有 `package.json` 别名。
   *
   * 与 `addressableDiscovery` 的区别是**谁在跑**：发现制是 runner 扫目录自动跑，人工类是
   * 人照着说明跑。两者都不能靠静态分析推断，所以都要项目声明。
   *
   * ## 这不是白名单，是「运行路径声明」
   *
   * `howToRun` 必填，且是**运行前缀**（如 `tsx scripts/dev/`）：判定时把它和命中文件自己的
   * 相对路径拼起来，要求那个字符串能在文件内容里找到（头注/文档注释都算）。
   *
   * 这一条把「豁免」反转成举证责任：
   *   - 有入口的脚本，入口就是证据（`package.json` 里那一行）；
   *   - 声明成人工类的脚本，证据是它自己写着怎么跑。
   *
   * 为什么是前缀而不是完整命令：一批工具通常共用同一个运行器与目录，但每个文件的后半段
   * 各不相同。写成完整命令就只能一个 glob 对一个文件（实测会逼出十几条几乎相同的声明，
   * 那等于把白名单抄了一遍）。写成前缀则「拼出来的那条命令」逐个文件落地校验。
   *
   * 少了这层，`addressableManualClasses` 就是一个谁都能加的豁免槽 —— 而豁免槽正是
   * 让「136 条里 112 条假阳性」发生的那类东西（假阳性一多，真孤儿就没人看了）。
   */
  addressableManualClasses: { glob: string; howToRun: string; reason: string }[]
  guardsDir: string
  packageJson: string
  ledger: string
  /** 备案载体：record 级发现的理由 + 复审日期；过期即失效（不再压制发现） */
  waivers: string
  /** 审计批次工作区（QE-03 产物），status 用它计算真洞产出曲线 */
  auditDir: string
  /** 面向人读的输出语言（triage 报告与提示词）；机器读数行始终英文 */
  locale?: 'en' | 'zh'
  /**
   * 报告目录。相对路径按 root 解析；CLI `--out` 覆盖本项。
   * 外部 `--config` 审计时默认落在配置文件旁，避免往被审计仓写文件。
   */
  reportDir?: string
  /** Next.js 服务端边界判据（可覆盖默认词表） */
  boundaries?: Partial<BoundaryConfig>
  /** 规格对账（AQ-ABS）：文档库 → 实现的对账范围 */
  spec?: SpecConfig
  /** 前端模块边界与敏感字段词表 */
  stores?: Partial<StoreConfig>
  /** 界面入口覆盖（inv23）：端点 ↔ 请求发送点的对账范围与外部渠道登记 */
  coverage?: CoverageConfig
  /** 软删表读点判据（inv25）：未声明时显式跳过，不报绿 */
  softDelete?: SoftDeleteConfig
  /** 错误码册码对拍（inv26）：正向靠契约台账，反向靠 throwPattern */
  errors?: ErrorCatalogConfig
  /** 干净检出可构建性（inv27）：command 是项目事实 */
  build?: CleanBuildConfig
  /** 变更型入口的速率/体积上限（inv28）：候选级，warn-only */
  rateLimit?: RateLimitConfig
  /**
   * 规则层选项：`rules[ruleId]`，只用于**消除误报**（公开路由声明、租户列清单、豁免表…）。
   * 纪律：项目差异一律在这里解决，不许按项目改判据分支；判据代码只修「证据采集精度」
   * （数据流、别名、封装、锁形态），且必须带坏样本自证。
   */
  rules?: Record<string, Record<string, unknown>>
  /**
   * 逐守卫降级：`{ "inv01": "warn" }` —— 该守卫的 error 一律按 warn 计。
   *
   * 用途：某条判据在**本仓**实测误报率过高（逐条回读源码核实过），它贡献的噪声正在淹没
   * 其它守卫的真洞。此时只有两种正当做法：改判据（把形状判准）或降级；**没有**第三种
   * 「把它从 CI 里删掉」——删掉之后它扫到的真洞也一并消失，且没人记得它曾经存在。
   *
   * 纪律：
   *  - 只允许 `error → warn`，不允许反向升级（升级等于让配置改判定口径）；
   *  - 降级必须在读数行里可见（`GUARD_DOWNGRADED` + `QE_RESULT downgraded=N`），
   *    否则「本轮 0 错」与「本轮把 159 条错降级了」在日志上长得一模一样；
   *  - 降级的理由（误报抽样证据、复审日期）写在审计报告里，本文件只放开关。
   */
  downgrades?: Record<string, 'warn'>
  /** 公开前的身份信息校验（leak-project-info） */
  leak?: {
    /** 项目代号黑名单文件；可指向本仓之外。缺省只查本机路径与凭据形态 */
    denylist?: string
    /**
     * 强制把当前 root 当作「本工具仓」来审（默认按 root === packageRoot 自动判定）。
     *
     * 只有自证样本需要它：样本根是临时目录，按自动判定会永远 skipped，
     * 于是「检测逻辑对不对」根本没被跑过——那是比跳过更坏的假绿（本守卫 2026-10-24 实测）。
     */
    selfAudit?: boolean
    /**
     * 是否检查行业业务实体词（默认开）。词表只收常见零售/交易类名词；
     * 其他垂直行业用 `denylist` 补充。
     */
    domainVocab?: boolean
  }
  /**
   * 是否校验本仓内置的守卫装配（inv13：别名、坏样本、孤儿守卫）。
   * CLI 模式下守卫在 npm 包里，本仓没有 qe/guards，应设为 false。
   */
  metaGuards?: boolean
}

export const defaultSourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

export const defaultConfig: QeConfig = {
  schema: { provider: 'prisma', path: 'prisma/schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
  source: { collector: 'ts', roots: ['src'], extensions: defaultSourceExtensions },
  ignore: ['node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'qe/fixtures', 'qe-report'],
  systemFields: {
    id: '框架生成',
    createdAt: '框架生成',
    updatedAt: '框架生成',
    deletedAt: '软删助手统一写入',
  },
  fieldExemptions: [],
  contracts: 'qe.contracts.json',
  scriptsDirs: ['scripts'],
  addressableLibDirs: [],
  addressableOrchestratorExts: ['.sh'],
  addressableTrackedOnly: true,
  addressableDiscovery: [],
  addressableManualClasses: [],
  guardsDir: 'qe/guards',
  packageJson: 'package.json',
  ledger: 'qe/ledger/incidents.json',
  waivers: 'qe/waivers.json',
  auditDir: 'qe-audit',
  locale: 'en',
  metaGuards: true,
  rules: {},
}

/** 深度合并嵌套配置块（schema/source/systemFields），数组整体替换 */
export function mergeConfig(base: QeConfig, patch?: Partial<QeConfig>): QeConfig {
  if (!patch) return { ...base }
  return {
    ...base,
    ...patch,
    schema: { ...base.schema, ...(patch.schema ?? {}) },
    source: { ...base.source, ...(patch.source ?? {}) },
    systemFields: { ...base.systemFields, ...(patch.systemFields ?? {}) },
    boundaries: { ...base.boundaries, ...(patch.boundaries ?? {}) },
    ...(base.spec || patch.spec ? { spec: { ...base.spec, ...(patch.spec ?? {}) } as SpecConfig } : {}),
    stores: { ...base.stores, ...(patch.stores ?? {}) },
  }
}

export async function loadConfig(root: string): Promise<QeConfig> {
  const file = path.join(root, 'qe.config.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return withSelfIgnore(root, { ...defaultConfig })
  }
  try {
    return withSelfIgnore(root, mergeConfig(defaultConfig, JSON.parse(raw) as Partial<QeConfig>))
  } catch (e) {
    throw new Error(`qe.config.json 解析失败：${(e as Error).message}`)
  }
}

/** copy-in 模式：包目录若在目标仓内，自动排除它，避免扫描到工具本身 */
function withSelfIgnore(root: string, config: QeConfig): QeConfig {
  const packageRoot = path.resolve(import.meta.dirname, '..', '..')
  const rel = path.relative(root, packageRoot).split(path.sep).join('/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || config.ignore.includes(rel)) return config
  return { ...config, ignore: [...config.ignore, rel] }
}
