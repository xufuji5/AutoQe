import { inv01 } from './inv01-column-writer.ts'
import { inv02 } from './inv02-column-reader.ts'
import { inv03 } from './inv03-dead-enum.ts'
import { inv06 } from './inv06-promise-backing.ts'
import { inv07 } from './inv07-gate-control.ts'
import { inv13 } from './inv13-addressable.ts'
import { inv20 } from './inv20-server-boundary.ts'
import { inv21 } from './inv21-seam-import.ts'
import { inv22 } from './inv22-zustand-store.ts'
import { inv23 } from './inv23-entry-channel.ts'
import { inv24 } from './inv24-assert-target.ts'
import { inv25 } from './inv25-soft-delete-read.ts'
import { inv26 } from './inv26-error-catalog.ts'
import { inv27 } from './inv27-clean-checkout.ts'
import { inv28 } from './inv28-rate-limit.ts'
import { specAbs } from './spec-abs.ts'
import { leakProjectInfo } from './leak-project-info.ts'
import { iso01 } from './iso01-vendored-engine.ts'
import { aq01 } from '../rules/AQ001-body-parse.ts'
import { aq02 } from '../rules/AQ002-status-bypass.ts'
import { aq03 } from '../rules/AQ003-catch-swallow.ts'
import { aq04 } from '../rules/AQ004-check-then-act.ts'
import { aq05 } from '../rules/AQ005-raw-sql-scope.ts'
import { aq06 } from '../rules/AQ006-route-auth.ts'
import { aq07 } from '../rules/AQ007-fake-green.ts'
import { aq08 } from '../rules/AQ008-idor.ts'
import { aq09 } from '../rules/AQ009-dedupe-key-required.ts'
import { aq10 } from '../rules/AQ010-reading-shape.ts'
import { aq11 } from '../rules/AQ011-hardcoded-tool-path.ts'
import { aq12 } from '../rules/AQ012-mock-reachable.ts'
import { aq13 } from '../rules/AQ013-hardcoded-datasource.ts'
import { aq14 } from '../rules/AQ014-tx-scoped-conflict-fallback.ts'
import { aq16 } from '../rules/AQ016-verify-always-true.ts'
import { aq17 } from '../rules/AQ017-script-outbound-unmocked.ts'
import { aq18 } from '../rules/AQ018-dev-gate-data-fallback.ts'
import { aq19 } from '../rules/AQ019-matcher-unescaped-dot.ts'
import { aq20 } from '../rules/AQ020-client-header-trust.ts'
import { aq21 } from '../rules/AQ021-edge-fire-and-forget.ts'
import { aq22 } from '../rules/AQ022-handwritten-comment-stripper.ts'
import { aq23 } from '../rules/AQ023-uncached-server-read.ts'
import { aq24 } from '../rules/AQ024-dev-perf-killswitch.ts'
import { aq25 } from '../rules/AQ025-serial-after-promise-all.ts'
import { aq26 } from '../rules/AQ026-long-copy-in-short-slot.ts'
import { aq27 } from '../rules/AQ027-long-copy-hardcoded.ts'
import { aq28 } from '../rules/AQ028-duplicate-copy-across-components.ts'
import { aq29 } from '../rules/AQ029-hardcoded-arbitrary-value.ts'
import { aq30 } from '../rules/AQ030-check-then-act-without-unique.ts'
import { aq31 } from '../rules/AQ031-prisma-read-no-select.ts'
import { aq32 } from '../rules/AQ032-duplicate-auth-in-tree.ts'
import { aq33 } from '../rules/AQ033-uncached-external-api-in-server-component.ts'
import { aq34 } from '../rules/AQ034-top-level-date-in-server-component.ts'
import { aq35 } from '../rules/AQ035-cache-tag-no-revalidate.ts'
import { aq37 } from '../rules/AQ037-partial-index-migration-missing.ts'
import { aq38 } from '../rules/AQ038-db-url-no-connection-limit.ts'
import { aq36 } from '../rules/AQ036-missing-compound-index.ts'
import { aq39 } from '../rules/AQ039-expiring-table-no-cleanup-job.ts'
import { aq40 } from '../rules/AQ040-gate-copy-literal.ts'
import { aq41 } from '../rules/AQ041-unsafe-dynamic-exec.ts'
import { aq42 } from '../rules/AQ042-xss-innerhtml.ts'
import { aq43 } from '../rules/AQ043-type-escape-hatch.ts'
import { aq44 } from '../rules/AQ044-hook-in-condition.ts'
import { aq15 } from './aq15-reuse-opportunity.ts'
import { mp01 } from '../rules/MP001-timer-after-unload.ts'
import { mp02 } from '../rules/MP002-component-style-isolation.ts'
import { mp03 } from '../rules/MP003-setdata-before-first-render.ts'
import { mp04 } from '../rules/MP004-back-needs-stack-fallback.ts'
import { mp05 } from '../rules/MP005-route-must-be-registered.ts'
import { mp06 } from '../rules/MP006-nav-tab-mismatch.ts'
import { mp07 } from '../rules/MP007-async-write-no-liveness.ts'
import { mp08 } from '../rules/MP008-class-defined-nowhere.ts'
import type { Guard } from '../lib/guard.ts'

/** 守卫单表：新增守卫必须在此登记，否则 inv13 报孤儿 */
export const guards: Guard[] = [
  inv01,
  inv02,
  inv03,
  inv06,
  inv07,
  inv13,
  inv20,
  inv21,
  inv22,
  inv23,
  inv24,
  inv25,
  inv26,
  inv27,
  inv28,
  specAbs,
  leakProjectInfo,
  iso01,
  // 规则层（`qe/rules/`）：判据是纯函数，经 `lib/rule-guard.ts` 接到同一接口上
  aq01,
  aq02,
  aq03,
  aq04,
  aq05,
  aq06,
  aq07,
  aq08,
  aq09,
  aq10,
  aq11,
  aq12,
  aq13,
  aq14,
  aq15,
  aq16,
  aq17,
  aq18,
  aq19,
  aq20,
  aq21,
  aq22,
  aq23,
  aq24,
  aq25,
  aq26,
  aq27,
  aq28,
  aq29,
  aq30,
  aq31,
  aq32,
  aq33,
  aq34,
  aq35,
  aq37,
  aq38,
  aq36,
  aq39,
  aq40,
  aq41,
  aq42,
  aq43,
  aq44,
  // 小程序域（`miniprogram/`）：宿主是双线程模型 + 页面栈 + 样式隔离，
  // 它的缺陷几乎都不报错——只在真机上表现成「样式没了/点了没反应/整块白掉」。
  mp01,
  mp02,
  mp03,
  mp04,
  mp05,
  mp06,
  mp07,
  mp08,
]
