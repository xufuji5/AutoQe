/**
 * 本仓库不得含宿主项目的身份信息（可公开分享的前置条件）。
 *
 * 为什么这条要写成守卫，而不是写在 README 里的一句承诺：
 * 「我会记得删掉项目名」和「我会记得加写点」是同一种病 —— 靠人记得等于没有机制。
 * 一旦这个仓要公开，泄漏是**不可撤回**的：删掉 commit 也删不掉已经被 clone/fork 的副本。
 * 所以判据必须在提交前就能红。
 *
 * 判据分三档，成因完全不同：
 *   ① 本机路径 / 家目录 —— 泄漏的是「谁在什么机器上开发」，附带用户名与目录结构；
 *   ② 凭据形态 —— 泄漏的是密码、私钥、带口令的连接串（后果不可逆，必须拦）；
 *   ③ 项目代号 —— 由外部黑名单提供（**不放在本仓**，见下）。
 *
 * 黑名单为什么必须外置：
 *   把「不许出现 A 项目名」写进本仓，等于用另一份明文登记了它。
 *   黑名单路径来自 `qe.config.json` 的 `leak.denylist`（可指向本仓之外的文件），
 *   未配置时本守卫只跑 ①② 两档，并如实声明黑名单为空（不许假装查过）。
 */

import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { readTextSafe, rel, walkFiles } from '../lib/fs.ts'

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

export const leakProjectInfo = defineGuard({
  id: 'leak-project-info',
  title: '本仓不得含宿主项目身份信息（可公开）',
  invariants: ['INV-META-01'],
  blindSpots: [
    '只做字符串匹配：改写过的项目代号（同义词、缩写、拼音）认不出来 —— 黑名单要跟着改',
    '黑名单本身不在本仓（配置项指向外部文件），因此「黑名单为空」时本守卫只能证明 ①② 两档干净',
    '不扫二进制与图片：截图里的界面文字、图里的路径不在射程',
    '跳过本守卫自己的夹具目录（夹具里刻意写着假路径），故夹具目录的内容不做递归校验',
  ],
  async run(ctx) {
    // 黑名单来源优先级：环境变量 > 配置。环境变量这条路是为「本机私有、入库即泄漏」的场景留的：
    // 黑名单里有项目代号，把它写进被扫描的仓库等于用另一份明文登记了它。
    const denySource = process.env.AUTOQE_DENYLIST || ctx.config.leak?.denylist || null
    const denyPath = denySource ? path.resolve(ctx.root, denySource) : null
    const ignore = [...new Set([...DEFAULT_IGNORE, ...ctx.config.ignore, 'qe/fixtures/leak-project-info'])]
    const files = (await walkFiles(ctx.root, '.', { ignore, ext: TEXT_EXT })).filter(
      // 黑名单文件按定义就写着禁用词：扫它必然自报，必须排除自己
      (f) => denyPath === null || path.resolve(f) !== denyPath,
    )

    const denyTerms = await loadDenyTerms(ctx.root, denySource ?? undefined)
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
        const line = lines[i]
        for (const p of LOCAL_PATH) {
          p.re.lastIndex = 0
          const m = p.re.exec(line)
          if (m) findings.push(err('LOCAL_PATH', `${p.why}：${truncate(m[0])}（换成相对路径或示例值）`, { file: r, line: i + 1 }))
        }
        for (const p of SECRET) {
          p.re.lastIndex = 0
          const m = p.re.exec(line)
          if (!m) continue
          if (isPlaceholderSecret(m[0])) continue
          findings.push(err('SECRET_SHAPE', `${p.why}：${truncate(m[0])}（凭据一律走 .env 且不入库）`, { file: r, line: i + 1 }))
        }
        for (const t of denyTerms) {
          if (line.includes(t.term)) {
            findings.push(
              err('PROJECT_CODEWORD', `出现项目代号「${t.term}」${t.hint ? `（改为${t.hint}）` : '（改为匿名代号，如 外部试点 A/B）'}`, {
                file: r,
                line: i + 1,
              }),
            )
          }
        }
      }
    }

    // 没有黑名单时不许沉默：0 命中的含义必须显式收窄
    if (denyTerms.length === 0) {
      findings.push(
        warn(
          'DENYLIST_EMPTY',
          '未配置项目代号黑名单（配置项 leak.denylist 或环境变量 AUTOQE_DENYLIST）：本轮只校验本机路径与凭据形态，代号未校验',
        ),
      )
    }
    if (scannedFiles === 0) {
      findings.push(err('EMPTY_SCAN', '未扫到任何文本文件：判据空集恒真，视为射程失效'))
    } else if (findings.length === 0) {
      findings.push(info('CLEAN', `${scannedFiles} 文件 / ${scannedLines} 行，无本机路径、无凭据形态、无黑名单代号`))
    }

    return {
      findings,
      scanned: `files=${scannedFiles} lines=${scannedLines} denyTerms=${denyTerms.length}`,
    }
  },
  selfTest: [
    {
      // 配了黑名单却一个都不命中：证明「干净」不是靠「没配黑名单」
      name: 'good：相对路径 + 占位凭据 + 黑名单未命中',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { source: { collector: 'none', roots: ['src'], extensions: [] }, leak: { denylist: 'deny.list' } },
    },
    {
      name: 'bad：本机绝对路径 / 密钥形态 / 可疑口令 / 命中黑名单代号',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 4,
      config: { source: { collector: 'none', roots: ['src'], extensions: [] }, leak: { denylist: 'deny.list' } },
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
