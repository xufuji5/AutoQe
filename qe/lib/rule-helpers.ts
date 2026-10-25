/**
 * 规则文件共用的纯函数（无 I/O）。
 *
 * 这些函数原先是每个规则各自抄一份的小工具，抄第三遍时就该收口：
 * 行号/证据片段/路由判定的口径只要有两份，「同一个命中在两个规则里行号不同」这类问题
 * 就会在下一次对账时以「是不是扫错文件了」的形式浪费半天。
 */

import type { RuleCtx } from './rule-guard.ts'

/** 字符偏移 → 1 基行号 */
export function lineOf(src: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

/** 命中处的单行原文（裁剪到 160 字符），用于 triage 时人眼复核 */
export function evidenceOf(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  let end = src.indexOf('\n', index)
  if (end === -1) end = src.length
  return src.slice(start, end).trim().slice(0, 160)
}

/**
 * status 字面量的合法取值来源。
 * 优先取项目配置（`rules.aq02.stateValues`），否则取 schema 的 enum 取值。
 * 两者都没有时返回空集合 —— 调用方必须据此声明「本轮未检查」，不许当成「没有缺陷」。
 */
export function stateValuesOf(ctx: RuleCtx): Set<string> {
  const declared = ctx.options.stateValues as string[] | undefined
  if (declared && declared.length > 0) return new Set(declared)
  return ctx.facts.stateValues
}

/** 小写模型名 → 唯一键清单（每项逗号连接） */
export function modelUniquesOf(ctx: RuleCtx): Map<string, string[]> {
  return ctx.facts.uniqueKeys
}

/**
 * 是不是「会被框架当路由装配」的文件。
 *
 * Next.js App Router 认 `route.ts`，Pages Router 认 `pages/api/**`。
 * 刻意不认 `app/**\/page.tsx`：页面是渲染入口，它的鉴权通常由 layout/middleware 统一做，
 * 逐个页面判会得到一整片误报（这是本项目首轮接入时的真实噪声来源）。
 */
export function isRouteFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/')
  if (/(^|\/)route\.(ts|tsx|js|mjs)$/.test(p)) return true
  if (/(^|\/)pages\/api\/.*\.(ts|tsx|js|mjs)$/.test(p)) return true
  return false
}
