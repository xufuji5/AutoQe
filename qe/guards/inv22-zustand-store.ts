import path from 'node:path'
import ts from 'typescript'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { collectorFor } from '../lib/providers.ts'
import { importSpecs, requireTs, sfOf } from '../lib/ast-utils.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv22-zustand-store')

const DEFAULT_SENSITIVE = [
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'apiKey',
  'cookie',
  'session',
]

export const inv22 = defineGuard({
  id: 'inv22-zustand-store',
  title: 'Zustand persist 落盘边界（敏感字段 / partialize / 版本）',
  invariants: ['INV-FE-01', 'INV-FE-02'],
  blindSpots: [
    '只扫 import 自 zustand 的文件；自研持久化（localStorage 直写、IndexedDB）不在射程',
    '敏感字段按 persist 作用域做词表命中：字段改名、运行时拼装的键名不判',
    '动态拼装 persist 配置（变量、展开、工厂函数）无法静态求值，可能漏判',
    '只查 version 是否存在，不校验 migrate 是否覆盖旧版本',
  ],
  async run(ctx) {
    requireTs(ctx.config)
    const sensitive = ctx.config.stores?.sensitiveKeys?.length ? ctx.config.stores.sensitiveKeys : DEFAULT_SENSITIVE
    const sources = await collectorFor(ctx.config).loadSources(ctx.root, ctx.config)
    const stores = sources.filter((s) => importSpecs(sfOf(s)).some((i) => i.spec === 'zustand' || i.spec.startsWith('zustand/')))
    if (stores.length === 0) {
      throw new NotApplicable('未发现 zustand 状态文件：本守卫不适用，不报绿')
    }

    const findings = []
    let persistCount = 0
    for (const src of stores) {
      const sf = sfOf(src)
      for (const call of persistCalls(sf)) {
        persistCount++
        const line = lineOf(sf, call)
        const partialize = findProp(call.arguments, 'partialize')
        // 敏感字段按整个 persist 作用域判定：无 partialize 时 state 会被整体落盘，只在 partialize 里查会漏
        const scopeText = call.getText(sf)
        const hit = sensitive.find((k) => new RegExp(`\\b${escapeRegExp(k)}\\b`).test(scopeText))
        if (hit) {
          findings.push(
            err('PERSIST_SENSITIVE', `${src.rel}:${line} persist 作用域内含敏感字段 ${hit}：会随 state 落盘，XSS/共享设备可直接读出`, {
              file: src.rel,
              line,
              entity: hit,
            }),
          )
        }
        if (!partialize) {
          findings.push(
            warn('PERSIST_WITHOUT_PARTIALIZE', `${src.rel}:${line} persist 未声明 partialize：整个 state 会被序列化落盘`, {
              file: src.rel,
              line,
            }),
          )
        } else {
          const text = partialize.initializer.getText(sf)
          if (/=>\s*state\s*$|return\s+state\b|\{\s*\.\.\.\s*state\s*\}/.test(text)) {
            findings.push(
              warn('PERSIST_FULL_STATE', `${src.rel}:${line} partialize 返回整个 state：等同于未裁剪`, { file: src.rel, line }),
            )
          }
        }
        if (!findProp(call.arguments, 'version')) {
          findings.push(
            warn('PERSIST_NO_VERSION', `${src.rel}:${line} persist 无 version：结构变更后旧数据会静默错位`, { file: src.rel, line }),
          )
        }
      }
    }

    if (findings.length === 0) {
      findings.push(info('STORE_CLEAN', `${stores.length} 个 zustand 文件、${persistCount} 处 persist，落盘边界齐全`))
    }
    return {
      findings,
      scanned: `files=${sources.length} stores=${stores.length} persists=${persistCount} sensitiveKeys=${sensitive.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：partialize 白名单 + version',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
    {
      name: 'bad：落盘 token + 无 partialize + 无 version',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      minWarnings: 2,
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
    {
      name: 'bad：无 partialize 时整个 state 落盘，敏感字段必须见红',
      root: path.join(FIXTURES, 'no-partialize'),
      expect: 'red',
      minErrors: 1,
      minWarnings: 1,
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
  ],
})

function persistCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ''
      if (name === 'persist') out.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 在 persist 的实参里递归找同名属性（配置可能包在 create(...) 内外层） */
function findProp(args: ts.NodeArray<ts.Expression>, name: string): ts.PropertyAssignment | null {
  const visit = (node: ts.Node): ts.PropertyAssignment | null => {
    if (ts.isPropertyAssignment(node) && propName(node) === name) return node
    let found: ts.PropertyAssignment | null = null
    ts.forEachChild(node, (child) => {
      if (!found) found = visit(child)
    })
    return found
  }
  for (const arg of args) {
    const found = visit(arg)
    if (found) return found
  }
  return null
}

function propName(p: ts.PropertyAssignment): string {
  const n = p.name
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text
  return ''
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
