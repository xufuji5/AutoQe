/**
 * 错误码三面互拍（INV-CORE-10）：册（contracts.errorCatalog）↔ 码（抛错点）。
 *
 * 失败形态两头都有：
 *   - 册上有码、码里没人抛：幽灵码。文档/SDK 对外承诺了一个永不发生的错误，
 *     调用方白写了处理分支——登记制失效。
 *   - 码里抛了、册上没登记：野生码。前端/调用方拿不到契约，只能猜字符串——
 *     猜错那天就是线上事故，而且册面读数依旧干净（假绿）。
 *
 * 判据与 inv06 同构：登记项 → 全仓必须有命中；外加反向：抛出的码必须已登记。
 * 反向需要仓级声明抛错形态（config.errors.throwPattern，带一个捕获组的正则），
 * 因为「throw 一个码」没有跨仓通用形状；未配置时反向显式未检查（info，不装绿）。
 */

import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import type { Finding } from '../lib/guard.ts'
import type { QeConfig, ErrorCatalogConfig } from '../lib/config.ts'
import { loadContracts } from '../lib/contracts.ts'
import { findPattern } from '../lib/search.ts'
import { readText, walkFiles } from '../lib/fs.ts'
import { defaultSourceExtensions } from '../lib/config.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv26-error-catalog')

type ConfigPatch = Partial<QeConfig>

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const inv26 = defineGuard({
  id: 'inv26-error-catalog',
  title: '错误码册码对拍：在用码必有抛错点，抛出的码必先登记',
  invariants: ['INV-CORE-10'],
  blindSpots: [
    '正向（册→码）是正则命中，不校验抛出路径真的可达',
    '反向（码→册）依赖仓级声明 throwPattern；未配置时「新码先登记」方向显式未检查（info 可见，不装绿）',
    '动态拼装的错误码（`ERR_` + suffix）两个方向都看不见',
    '提交体一侧（第三面）属发版流程对拍，不在本守卫射程',
  ],
  async run(ctx) {
    const contracts = await loadContracts(ctx.root, ctx.config)
    if (!contracts) {
      // 与 inv06 同理：台账未配置 = 没有事实来源，诚实状态是 skipped 而不是绿
      throw new NotApplicable(
        'CONTRACTS_MISSING',
        `契约台账未配置：${ctx.config.contracts}（错误码无处登记 ⇒ 本轮未检查；先跑 qe init 建台账）`,
      )
    }
    const opts = ctx.config.errors ?? {}
    const roots = opts.roots?.length ? opts.roots : ctx.config.source.roots
    const catalog = contracts.errorCatalog
    const findings: Finding[] = []
    const blanks = catalog.filter((c) => !c.trim())
    for (const _ of blanks) {
      findings.push(err('ERROR_CODE_BLANK', 'errorCatalog 里有空码：登记占位等同豁免槽，删或补全'))
    }
    const codes = [...new Set(catalog.filter((c) => c.trim()))]

    if (codes.length === 0 && !opts.throwPattern) {
      findings.push(warn('NO_CATALOG', 'errorCatalog 为空且未配置 throwPattern：错误码对拍空转（空集恒真）'))
      return { findings, scanned: `catalog=0 throwPattern=off` }
    }

    // 正向：册上每个码在源码里必有抛错点（inv06 同构）
    let dead = 0
    for (const code of codes) {
      const result = await findPattern(ctx.root, roots, escapeRe(code), ctx.config)
      if (!result.matched) {
        dead++
        findings.push(
          err('DEAD_ERROR_CODE', `错误码 ${code} 登记在册但全仓无人抛（扫 ${result.files} 文件）：幽灵码——补抛错点或从册面移除`, {
            entity: code,
          }),
        )
      }
    }

    // 反向：源码里抛出的每个码必须已登记
    let wild = 0
    let thrownTotal = 0
    if (opts.throwPattern) {
      let re: RegExp
      try {
        re = new RegExp(opts.throwPattern, 'g')
      } catch (e) {
        findings.push(err('BAD_THROW_PATTERN', `errors.throwPattern 正则有误：${(e as Error).message}`))
        return { findings, scanned: `catalog=${codes.length} throwPattern=invalid` }
      }
      const extensions = ctx.config.source.extensions.length ? ctx.config.source.extensions : defaultSourceExtensions
      const batches = await Promise.all(roots.map((dir) => walkFiles(ctx.root, dir, { ignore: ctx.config.ignore, ext: extensions })))
      const files = [...new Set(batches.flat())].sort()
      const registered = new Set(codes)
      for (const file of files) {
        const text = await readText(file)
        text.split(/\r?\n/).forEach((line, idx) => {
          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(line)) !== null) {
            const code = m[1]
            if (!code) continue
            thrownTotal++
            if (!registered.has(code)) {
              wild++
              findings.push(
                err('UNREGISTERED_ERROR_CODE', `抛出的错误码 ${code} 未登记进 errorCatalog：野生码——先登记再抛`, {
                  entity: code,
                  file: path.relative(ctx.root, file).split(path.sep).join('/'),
                  line: idx + 1,
                }),
              )
            }
          }
        })
      }
      if (files.length === 0) {
        findings.push(warn('THROW_SCAN_EMPTY', `反向对拍扫到 0 个源文件（roots=${roots.join(',')}）：空集恒真不算绿`))
      }
    } else {
      findings.push(
        info('REVERSE_UNCONFIGURED', '未配置 errors.throwPattern：「新码先登记」方向本轮未检查（在抛未登记的码看不见）'),
      )
    }

    if (findings.length === 0) {
      findings.push(info('ERROR_CATALOG_CLEAN', `错误码 ${codes.length} 个：册面全部有抛错点，抛出侧全部已登记`))
    }
    return {
      findings,
      scanned: `catalog=${codes.length} dead=${dead} thrown=${thrownTotal} wild=${wild} reverse=${opts.throwPattern ? 'on' : 'off'} roots=${roots.join(',')}`,
    }
  },
  selfTest: [
    {
      name: 'good：册面码有抛错点，抛出的码已登记（双向对拍）',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: {
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        errors: { throwPattern: "ApiError\\('([A-Z_]+)'" },
      } as ConfigPatch,
    },
    {
      name: 'bad：册面有码、全仓无人抛（幽灵码）',
      root: path.join(FIXTURES, 'bad-dead'),
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      config: {
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      } as ConfigPatch,
    },
    {
      name: 'bad：抛出的码未登记（野生码）',
      root: path.join(FIXTURES, 'bad-unregistered'),
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      config: {
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        errors: { throwPattern: "ApiError\\('([A-Z_]+)'" },
      } as ConfigPatch,
    },
    {
      name: 'warn：册为空且未配 throwPattern（空集恒真不是绿）',
      root: path.join(FIXTURES, 'bad-unregistered'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: {
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      } as ConfigPatch,
    },
  ],
})
