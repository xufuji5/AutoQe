/**
 * 本仓库不得含宿主项目的身份信息（可公开分享的前置条件）。
 *
 * 为什么这条要写成守卫，而不是写在 README 里的一句承诺：
 * 「我会记得删掉项目名」和「我会记得加写点」是同一种病 —— 靠人记得等于没有机制。
 * 一旦这个仓要公开，泄漏是**不可撤回**的：删掉 commit 也删不掉已经被 clone/fork 的副本。
 * 所以判据必须在提交前就能红。
 *
 * 判据分四档，成因完全不同：
 *   ① 本机路径 / 家目录 —— 泄漏的是「谁在什么机器上开发」，附带用户名与目录结构；
 *   ② 凭据形态 —— 泄漏的是密码、私钥、带口令的连接串（后果不可逆，必须拦）；
 *   ③ 项目代号 —— 由外部黑名单提供（**不放在本仓**，见下）；
 *   ④ 行业业务实体词 —— 泄漏的是「这个工具是从哪个垂直行业长出来的」，示例会被读成行业绑定。
 *      通用工具的一切示例都该用 请求 / 资产 / 记录 这类中性实体，不写任何一行零售语义。
 *
 * ## 扫**两个面**，不只扫工作树
 * 四档判据要作用在两个面上：**文件正文**和**提交信息**。
 * 只扫文件正文会漏掉一整类：作者在 commit message 里写了项目名。
 * 那是最贵的一种——它不在任何文件里，`git log` 却是随仓库一起分发的；
 * 而且**删文件删不掉它**（历史里的记录还在，已被 clone 的副本更删不掉）。
 * 实测过一次：自己在提交信息里写了两个真实仓名，判据全绿——因为它根本没看那个面。
 *
 * 提交信息面与文件面共用同一套三档判据（`scanLine`），不另写一套：
 * 两套判据必然在「算不算凭据形态」上分叉，然后得出两个不一样的结论。
 *
 * 黑名单为什么必须外置：
 *   把「不许出现 A 项目名」写进本仓，等于用另一份明文登记了它。
 *   黑名单路径来自 `qe.config.json` 的 `leak.denylist`（可指向本仓之外的文件），
 *   未配置时本守卫只跑 ①② 两档，并如实声明黑名单为空（不许假装查过）。
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { readTextSafe, rel, walkFiles } from '../lib/fs.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { stateFilesInIndex } from '../lib/repo-hygiene.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/leak-project-info')

/** 只扫文本类文件：二进制里偶然的字节序列不是「泄漏」，报出来只会消耗信任 */
const TEXT_EXT = ['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.txt', '.prisma', '.css', '.html']

/** ① 本机路径：会连带泄漏用户名与目录结构 */
const LOCAL_PATH: { re: RegExp; why: string }[] = [
  // 单字母盘符 + 单斜杠：`(?<![A-Za-z])` 排除 URL 的 `s://`（漏了这个，任何 https 链接都会被当成 D 盘路径）
  { re: /(?<![A-Za-z])[A-Za-z]:[\\/](?:Users|用户)[\\/][^\s'"`)]+/g, why: '本机用户目录绝对路径' },
  { re: /(?<![A-Za-z])[A-Za-z]:[\\/](?![\\/])[A-Za-z0-9_.-]+[\\/][^\s'"`)]*/g, why: '本机绝对路径（含盘符）' },
  { re: /(^|[\s'"`(])\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g, why: '本机用户目录绝对路径' },
]

/** ② 凭据形态：命中即高危，与业务无关 */
const SECRET: { re: RegExp; why: string }[] = [
  { re: /\b(?:sk|rk)-[A-Za-z0-9]{20,}/g, why: '疑似 API 密钥' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, why: '疑似 AWS Access Key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, why: '疑似 GitHub Token' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, why: '私钥块' },
  { re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s@]+@/gi, why: '带口令的连接串' },
  { re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi, why: '明文口令赋值' },
  { re: /\bwx[a-z0-9]{16}\b/g, why: '疑似微信 AppID/密钥形态字符串' },
]

/**
 * ④ 行业业务实体词。只收「一眼能看出垂直行业」的名词：
 * 零售/交易类中文实体，以及无歧义的英文标识（`sku`/`coupon`/`cart`）。
 * 不收 `order`/`product`/`checkout` 这类多义词——`checkout` 在 git 语境里天天出现，
 * `order` 在普通英文散文里出现，ban 掉只会制造假红（2026-10-24 自测实测）。
 */
const DOMAIN_VOCAB_RE =
  /\b(?:sku|coupon|cart)\b|电商|商城|订单|库存|商品|商户|店铺|退款|结算|购物车|优惠券|卖超|批号|下单|发货|物流|团购|团长|售后/gi
const DOMAIN_HINT = '改为「请求 / 资产 / 记录」这类通用实体名'

const DEFAULT_IGNORE = ['node_modules', '.git', 'qe-report', 'qe-audit', '.fixtures-generated', 'dist', 'build', '.next']

interface DenyTerm {
  term: string
  /** 命中后给出的替代说法，提醒改稿方向（可选） */
  hint?: string
}

function parseDenylist(text: string): DenyTerm[] {
  const out: DenyTerm[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [term, hint] = line.split('=>').map((s) => s.trim())
    if (term) out.push({ term, hint })
  }
  return out
}

/** 提交信息面最多扫多少个提交；达到上限时要在读数里说出来 */
const COMMIT_SCAN_LIMIT = 1000
/** 单条提交信息的截断长度：历史里塞进巨型文件时别把内存打满 */
const COMMIT_MSG_CAP = 8000

interface LineHit {
  code: string
  message: string
}

/**
 * 查**一行自由文本**里的四档泄漏。文件正文与提交信息共用这一份 —— 两个面各写一套判据，
 * 必然在「算不算凭据形态」上分叉，然后得出两个不一样的结论。
 */
function scanLine(line: string, denyTerms: DenyTerm[], checkDomain: boolean): LineHit[] {
  const out: LineHit[] = []
  for (const p of LOCAL_PATH) {
    p.re.lastIndex = 0
    const m = p.re.exec(line)
    if (m) out.push({ code: 'LOCAL_PATH', message: `${p.why}：${truncate(m[0])}（换成相对路径或示例值）` })
  }
  for (const p of SECRET) {
    p.re.lastIndex = 0
    const m = p.re.exec(line)
    if (!m) continue
    if (isPlaceholderSecret(m[0])) continue
    out.push({ code: 'SECRET_SHAPE', message: `${p.why}：${truncate(m[0])}（凭据一律走 .env 且不入库）` })
  }
  for (const t of denyTerms) {
    if (!line.includes(t.term)) continue
    out.push({
      code: 'PROJECT_CODEWORD',
      message: `项目代号「${t.term}」${t.hint ? `（改为${t.hint}）` : '（改为匿名代号，如 外部试点 A/B）'}`,
    })
  }
  if (checkDomain) {
    DOMAIN_VOCAB_RE.lastIndex = 0
    const m = DOMAIN_VOCAB_RE.exec(line)
    if (m) out.push({ code: 'DOMAIN_VOCAB', message: `行业业务实体词「${m[0]}」（${DOMAIN_HINT}）` })
  }
  return out
}

/** 跑一条 git 命令；失败（不是仓 / 没装 git / 超时）一律返回 null，由调用方如实声明「没结论」 */
function gitOut(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

export const leakProjectInfo = defineGuard({
  id: 'leak-project-info',
  title: '本仓不得含宿主项目身份信息（可公开）',
  invariants: ['INV-META-01'],
  blindSpots: [
    '只做字符串匹配：改写过的项目代号（同义词、缩写、拼音）认不出来 —— 黑名单要跟着改',
    '黑名单本身不在本仓（配置项指向外部文件），因此「黑名单为空」时本守卫只能证明 ①②④ 三档干净',
    '行业实体词表只收常见零售/交易类名词：医疗、金融等其他垂直行业的口径靠 `leak.denylist` 补充（可用 `leak.domainVocab=false` 关闭本档）',
    '本守卫自身源码与夹具目录不做递归校验（源码里必然写着要禁的词，夹具里刻意写着坏样本）',
    '行业实体词只查文件正文，不查提交信息：历史提交不可改写，且这一档管的是「随包示例」，代号与凭据两档仍覆盖提交面',
    '不扫二进制与图片：截图里的界面文字、图里的路径不在射程',
    '提交信息面只看**本目录是仓根**时的那段历史（`git rev-parse --show-toplevel` 必须等于 root）：审子目录时不扫父仓历史，否则会把父仓的代号算到子目录头上',
    '提交信息面默认扫最近 1000 个提交：更早的历史不在本轮读数里（`scanned` 会报实际上限）',
    '索引面只认内置的数据/状态路径清单（`qe/lib/repo-hygiene.ts`）：新增的数据目录必须加进那张表，否则不判',
  ],
  async run(ctx) {
    // 射程自检：本判据问的是「**本工具仓**能不能公开」，不是「客户仓里有没有客户名」。
    // 客户仓里必然有自己的项目名与开发机路径——那不是缺陷，是它的内容。
    // 实测：在试点仓上跑一次顶出 64 条 error，全是「客户仓含客户信息」，
    // 把真读数淹掉的同时，还让「泄漏审计」这件事在目标仓失去可信度。
    const packageRoot = path.resolve(import.meta.dirname, '..', '..')
    // 自证样本必须能跑到检测逻辑：样本根是临时目录，按自动判定会永远 skipped，
    // 于是「检测逻辑对不对」从未被验证——那是比跳过更坏的假绿（2026-10-24 实测 2 条 fixture 全红）。
    if (ctx.config.leak?.selfAudit !== true && path.resolve(ctx.root) !== packageRoot) {
      throw new NotApplicable(
        'SELF_ONLY_GUARD',
        '本判据只审本工具仓自身（公开前的身份信息校验）；目标仓含自身项目信息属内容，不是缺陷',
      )
    }
    // 黑名单来源优先级：环境变量 > 配置。环境变量这条路是为「本机私有、入库即泄漏」的场景留的：
    // 黑名单里有项目代号，把它写进被扫描的仓库等于用另一份明文登记了它。
    const denySource = process.env.AUTOQE_DENYLIST || ctx.config.leak?.denylist || null
    const denyPath = denySource ? path.resolve(ctx.root, denySource) : null
    const ignore = [...new Set([...DEFAULT_IGNORE, ...ctx.config.ignore, 'qe/fixtures/leak-project-info'])]
    // 本守卫源码里按定义写着要禁的词：扫它必然自报，必须排除自己
    const selfFile = path.resolve(import.meta.dirname, 'leak-project-info.ts')
    const files = (await walkFiles(ctx.root, '.', { ignore, ext: TEXT_EXT })).filter(
      // 黑名单文件按定义就写着禁用词：扫它必然自报，必须排除自己
      (f) => (denyPath === null || path.resolve(f) !== denyPath) && path.resolve(f) !== selfFile,
    )

    const denyTerms = await loadDenyTerms(ctx.root, denySource ?? undefined)
    // 默认开：行业实体词是「可公开分享」的一部分，不该靠用户记得去开
    const checkDomain = ctx.config.leak?.domainVocab !== false
    const findings = []
    let scannedFiles = 0
    let scannedLines = 0

    for (const file of files) {
      const r = rel(ctx.root, file)
      const text = await readTextSafe(file)
      if (text === null) continue
      scannedFiles++
      const lines = text.split(/\r?\n/)
      scannedLines += lines.length

      for (let i = 0; i < lines.length; i++) {
        for (const hit of scanLine(lines[i], denyTerms, checkDomain)) {
          findings.push(err(hit.code, hit.message, { file: r, line: i + 1 }))
        }
      }
    }

    // ④ 面：提交信息。与文件正文共用三档判据，只是取数来源不同（git log）。
    // 这一面的价值在于「不可撤回」：文件里的代号可以在下一次提交删掉，
    // 历史里的删不掉——只要仓库被 clone 过，删本地记录也没有意义。
    let commitNote = 'commits=n/a'
    const top = gitOut(ctx.root, ['rev-parse', '--show-toplevel'])
    if (top === null) {
      // 不是仓 / 没装 git：**这一档确实没有对象**（空集），不是「没检查」
      findings.push(info('COMMITS_NONE', '本目录不在 git 工作树内（或 git 不可用）：提交信息面没有可扫对象'))
      commitNote = 'commits=0'
    } else if (path.resolve(top.trim()) !== path.resolve(ctx.root)) {
      // 审子目录时不扫父仓历史：父仓的代号不是这个目录的缺陷
      findings.push(info('COMMITS_NONE', '本目录不是仓根：提交信息面只扫仓根那一层，父仓历史不在本轮射程'))
      commitNote = 'commits=0'
    } else if (gitOut(ctx.root, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) {
      // 空仓（刚 init、还没有提交）：这是**空集**，不是「没结论」。两者在读数上必须分开，
      // 否则每个新仓第一次跑都会看到一条假的「未扫描」，然后人人都学会忽略它。
      findings.push(info('COMMITS_NONE', '本仓还没有任何提交：提交信息面没有可扫对象'))
      commitNote = 'commits=0'
    } else {
      const raw = gitOut(ctx.root, ['log', `--pretty=format:%h%x1f%B%x1e`, `--max-count=${COMMIT_SCAN_LIMIT}`])
      if (raw === null) {
        // 是仓但取不出来：这一档**没有结论**，必须显式报「未扫描」，不许当干净
        findings.push(warn('COMMITS_NOT_SCANNED', '提交信息面调用 git log 失败：这一档本轮没有结论（不代表干净）'))
        commitNote = 'commits=unknown'
      } else {
        let commits = 0
        let commitLines = 0
        for (const record of raw.split('\x1e')) {
          const text = record.replace(/^\s+/, '')
          if (text === '') continue
          const sep = text.indexOf('\x1f')
          if (sep < 0) continue
          const hash = text.slice(0, sep).trim()
          const body = text.slice(sep + 1, sep + 1 + COMMIT_MSG_CAP)
          commits += 1
          const bodyLines = body.split(/\r?\n/)
          commitLines += bodyLines.length
          for (let i = 0; i < bodyLines.length; i++) {
            // 行业实体词**不查提交信息**：历史提交是既成记录，改写它要重写历史；
            // 而这一档管的是「随包发布的示例别绑定行业」，不是历史措辞。代号/凭据两档照旧覆盖提交面。
            for (const hit of scanLine(bodyLines[i], denyTerms, false)) {
              findings.push(
                err(hit.code, `提交 ${hash} 的信息（第 ${i + 1} 行）：${hit.message}`, {
                  entity: `commit:${hash}`,
                }),
              )
            }
          }
        }
        commitNote = `commits=${commits}${commits >= COMMIT_SCAN_LIMIT ? `(达到上限 ${COMMIT_SCAN_LIMIT})` : ''} commitLines=${commitLines}`
      }
    }

    // ⑤ 面：索引。`.gitignore` 只挡未跟踪文件；一次 `git add -f` 之后它就彻底失效。
    // 所以第二层必须是「索引里出现即判红」——数据文件进历史是删不掉的。
    // 与文件正文面分开：这里问的是「会不会被提交」，不是「内容里有没有敏感词」。
    let indexNote = 'index=n/a'
    const listing = gitOut(ctx.root, ['ls-files', '-z'])
    if (listing === null) {
      findings.push(warn('INDEX_NOT_SCANNED', '索引面调用 git ls-files 失败：这一档本轮没有结论（不代表干净）'))
      indexNote = 'index=unknown'
    } else {
      const tracked = listing.split('\0').filter((p) => p.length > 0)
      const trackedState = stateFilesInIndex(tracked)
      for (const h of trackedState) {
        findings.push(
          err(
            'TRACKED_STATE_FILE',
            `${h.path} 是${h.why}，不得进入索引（删文件删不掉历史：git rm --cached 后确认 .gitignore 覆盖）`,
            { file: h.path },
          ),
        )
      }
      indexNote = `index=${tracked.length} trackedState=${trackedState.length}`
    }

    // 没有黑名单时不许沉默：0 命中的含义必须显式收窄
    if (denyTerms.length === 0) {
      findings.push(
        warn(
          'DENYLIST_EMPTY',
          '未配置项目代号黑名单（配置项 leak.denylist 或环境变量 AUTOQE_DENYLIST）：本轮只校验本机路径、凭据形态与行业实体词，代号未校验',
        ),
      )
    }
    if (scannedFiles === 0) {
      findings.push(err('EMPTY_SCAN', '未扫到任何文本文件：判据空集恒真，视为射程失效'))
    } else if (findings.length === 0) {
      findings.push(info('CLEAN', `${scannedFiles} 文件 / ${scannedLines} 行，无本机路径、无凭据形态、无行业实体词、无黑名单代号`))
    }

    return {
      findings,
      scanned: `files=${scannedFiles} lines=${scannedLines} denyTerms=${denyTerms.length} ${commitNote} ${indexNote}`,
    }
  },
  selfTest: [
    {
      // 配了黑名单却一个都不命中：证明「干净」不是靠「没配黑名单」
      name: 'good：相对路径 + 占位凭据 + 黑名单未命中',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { source: { collector: 'none', roots: ['src'], extensions: [] }, leak: { denylist: 'deny.list', selfAudit: true } },
    },
    {
      name: 'bad：本机绝对路径 / 密钥形态 / 可疑口令 / 命中黑名单代号',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 4,
      config: { source: { collector: 'none', roots: ['src'], extensions: [] }, leak: { denylist: 'deny.list', selfAudit: true } },
    },
    {
      // 先红后绿：行业实体词档必须自证能命中，否则它只是一句声明
      name: 'bad-domain：示例里写了垂直行业实体（该报）',
      root: path.join(FIXTURES, 'bad-domain'),
      expect: 'red',
      minErrors: 2,
      config: { source: { collector: 'none', roots: ['src'], extensions: [] }, leak: { denylist: 'deny.list', selfAudit: true } },
    },
    {
      // 开关必须真的能关：否则「可按项目关闭」只是注释里的一句话
      name: 'bad-domain + domainVocab=false：显式关闭后不再报该档',
      root: path.join(FIXTURES, 'bad-domain'),
      expect: 'green',
      config: { source: { collector: 'none', roots: ['src'], extensions: [] }, leak: { denylist: 'deny.list', selfAudit: true, domainVocab: false } },
    },
  ],
})

async function loadDenyTerms(root: string, configured?: string): Promise<DenyTerm[]> {
  if (!configured) return []
  const file = path.isAbsolute(configured) ? configured : path.join(root, configured)
  const text = await readTextSafe(file)
  return text === null ? [] : parseDenylist(text)
}

/**
 * 文档里的占位口令不该报红：`postgres://user:__REDACTED__@host/db`、`user:<password>@` 是
 * 正确的示范写法，报红会逼人把示例删掉，最后连示例都没了。
 * 只有「长得像真值」的口令才算泄漏（≥8 位、非占位词、非纯 x/星号）。
 */
function isPlaceholderSecret(match: string): boolean {
  const value = match
    .replace(/^.*?:\/\//, '')
    .replace(/@.*$/, '')
    .replace(/^[^:]*:/, '')
  if (!value) return false
  if (/^(?:_{1,2}[A-Z_]+_{0,2}|<[^>]*>|\*+|x{4,}|X{4,}|\{[^}]*\}|\$\{[^}]*\}|changeme|placeholder|redacted|your[-_]?\w*|example)$/i.test(value)) return true
  return false
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}
