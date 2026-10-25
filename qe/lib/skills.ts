/**
 * 事故知识库（`qe/skills/`）的加载与校验。
 *
 * 为什么要有这一层，而不是「文档放在那儿，人自己看」：
 * 这套方法论的价值全在「上次踩的坑这次别再踩」，但**人不会主动去翻目录**。
 * 把它做成可执行的三件事，知识才会真的被消费：
 *   ① `skills`         —— 列出来（谁、哪一类、对应哪条规则）；
 *   ② `skills --check` —— 校验形状（缺 provenance 的条目就是无出处的规则）；
 *   ③ `skills --checklist` —— 当场生成立项/复盘审计清单，直接贴进下一轮 prompt。
 *
 * 单源纪律：清单由文件现算，不落第二份 markdown。落一份就等于早晚要同步两份。
 */

import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { readTextSafe } from './fs.ts'

export interface Skill {
  /** 目录名，例如 SK004-check-then-act */
  slug: string
  id: string
  title: string
  /** rule = 有确定性判据；manual = 只能人工走查 */
  status: string
  /** 关联的规则/守卫 id，可为空 */
  rules: string[]
  defectClass: string
  /** 出处：哪次真实事故。缺了就是「凭想象写的判据」 */
  provenance: string
  /** 一句话自省问题——清单里逐条问的就是它 */
  question: string
  body: string
  file: string
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseFront(text: string): { meta: Record<string, string>; body: string } {
  const m = FRONT.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: text.slice(m[0].length) }
}

export async function loadSkills(dir: string): Promise<Skill[]> {
  let entries: string[]
  try {
    entries = await readdir(dir, { withFileTypes: true }).then((list) =>
      list.filter((e) => e.isDirectory()).map((e) => e.name),
    )
  } catch {
    return []
  }
  const out: Skill[] = []
  for (const slug of entries.sort()) {
    const file = path.join(dir, slug, 'SKILL.md')
    const text = await readTextSafe(file)
    if (text === null) continue
    const { meta, body } = parseFront(text)
    out.push({
      slug,
      id: meta.id ?? '',
      title: meta.title ?? '',
      status: meta.status ?? '',
      rules: (meta.rules ?? '')
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      defectClass: meta.defectClass ?? '',
      provenance: meta.provenance ?? '',
      question: meta.question ?? '',
      body,
      file,
    })
  }
  return out
}

/** 形状校验：缺任何一栏都可疑，但只有「缺出处」「缺自省问题」算红 —— 其余算提示 */
export function validateSkills(skills: Skill[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const s of skills) {
    if (!s.id) errors.push(`${s.slug}：缺 id`)
    if (seen.has(s.id)) errors.push(`${s.slug}：id ${s.id} 重复`)
    seen.add(s.id)
    if (!s.title) errors.push(`${s.slug}：缺 title`)
    if (!s.question) errors.push(`${s.slug}：缺 question（一条没有自省问题的条目，用的时候没人会想到它）`)
    if (!s.provenance) errors.push(`${s.slug}：缺 provenance（没有真实事故出处的判据，是凭想象写的）`)
    if (!s.defectClass) warnings.push(`${s.slug}：缺 defectClass，清单里无法归类`)
    if (s.status === 'rule' && s.rules.length === 0) warnings.push(`${s.slug}：标 rule 但没关联任何规则 id`)
    if (s.status === 'manual' && s.rules.length > 0) warnings.push(`${s.slug}：标 manual 却关联了规则 id`)
  }
  return { errors, warnings }
}

export function skillsTable(skills: Skill[]): string {
  const rows = skills.map(
    (s) => `${s.id.padEnd(6)} ${s.status.padEnd(7)} ${(s.rules.join(',') || '-').padEnd(8)} ${s.title}`,
  )
  return ['ID     STATUS  RULES    TITLE', ...rows].join('\n')
}

/** 立项/复盘审计清单：把每条知识的自省问题按类别铺开 */
export function skillsChecklist(skills: Skill[]): string {
  const byClass = new Map<string, Skill[]>()
  for (const s of skills) {
    const k = s.defectClass || '未归类'
    byClass.set(k, [...(byClass.get(k) ?? []), s])
  }
  const out: string[] = []
  out.push('# 审计清单（由 qe/skills 现算，勿手工维护）')
  out.push('')
  out.push('用法：立项时逐条问一遍；复盘时把「答不上来」的那几条变成判据。')
  out.push('')
  for (const [cls, list] of [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`## ${cls}`)
    out.push('')
    for (const s of list) {
      const tag = s.rules.length > 0 ? `（${s.rules.join(' / ')}）` : '（人工走查）'
      out.push(`- [ ] **${s.title}**${tag} — ${s.question}`)
    }
    out.push('')
  }
  out.push(`合计 ${skills.length} 条。`)
  return out.join('\n')
}
