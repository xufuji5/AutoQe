/**
 * 仓库卫生：哪些**数据/状态**文件绝不许进入 git 索引。
 *
 * 为什么单独成判据，而不是继续靠 `.gitignore`：
 *   `.gitignore` 只挡「没被跟踪的文件」。一次 `git add -f`、一次在清理忽略规则时误删一行、
 *   一次从别的仓拷了 `.git` 目录进来 —— 文件就已经在索引里了，`.gitignore` 从此对它无效。
 *   而这类文件泄漏的是**别的项目的扫描结果、本机身份与审计记录**，一旦进历史就删不干净。
 *   所以第一层是忽略规则，第二层必须是「索引里出现即判红」。
 *
 * 为什么 `qe/ledger/incidents.json` 不在名单里：它是**经验**（哪次事故催生了哪条判据），
 * 是这个仓要长期积累的东西；而 `qe-report/`、`qe-audit/`、扫描/裁决导出、`qe.project.json`
 * 是**数据**（某次扫描的读数、某台机器的身份），随项目走、不随仓走。
 *
 * 纯函数：入参是 `git ls-files` 输出的仓库相对路径，返回命中项与理由。
 * 自证例在 `engine-selftest`（坏样本必须先红）。
 */

export interface StatePathRule {
  pattern: RegExp
  why: string
}

/** 允许出现在索引里的例外（按 basename 判）：`.env` 的名字里就带着 `.env`，但它是范例 */
const ALLOWED_BASENAMES = new Set(['.env.example'])

export const STATE_PATH_RULES: StatePathRule[] = [
  { pattern: /(^|\/)(qe-report|qe-audit)\//, why: '扫描报告/审计产物（含他项目读数）' },
  { pattern: /^reports\//, why: '导出报告目录' },
  { pattern: /^scan-[^/]*\.txt$/, why: '一次性扫描导出（含项目名与本机路径）' },
  { pattern: /^triage-[^/]*\.txt$/, why: '一次性裁决导出' },
  { pattern: /^qe\.project\.json$/, why: '状态身份（本机 UUID，跟着机器走不跟着仓走）' },
  { pattern: /^qe\.waivers\.json$/, why: '运行期豁免台账' },
  { pattern: /^qe\.contracts\.json$/, why: '运行期契约台账（夹具/demo 里的同名文件不受此条约束）' },
  { pattern: /(^|\/)denylist\.local\.txt$/, why: '本地黑名单（含内部项目代号/客户名）' },
  { pattern: /^qe\/denylist(?:\.[^/]*)?\.txt$/, why: '黑名单（含内部项目代号/客户名）' },
  { pattern: /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/, why: '环境变量文件（凭据）' },
  { pattern: /(^|\/)[^/]*\.log$/, why: '日志' },
  { pattern: /(^|\/)[^/]*\.(?:db|sqlite|sqlite3)$/, why: '本机数据库文件' },
]

export interface StatePathHit {
  path: string
  why: string
}

/**
 * 从索引路径里挑出数据/状态文件。
 *
 * 只看**索引**（`git ls-files`），不看磁盘：磁盘上存在 `qe-report/` 是正常的（被忽略）；
 * 判据问的是「它会不会被提交」，所以对象必须是索引。
 */
export function stateFilesInIndex(paths: string[]): StatePathHit[] {
  const hits: StatePathHit[] = []
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!p) continue
    const base = p.slice(p.lastIndexOf('/') + 1)
    if (ALLOWED_BASENAMES.has(base)) continue
    const rule = STATE_PATH_RULES.find((r) => r.pattern.test(p))
    if (rule) hits.push({ path: p, why: rule.why })
  }
  return hits
}
