import { inv01 } from './inv01-column-writer.ts'
import { inv02 } from './inv02-column-reader.ts'
import { inv03 } from './inv03-dead-enum.ts'
import { inv06 } from './inv06-promise-backing.ts'
import { inv07 } from './inv07-gate-control.ts'
import { inv13 } from './inv13-addressable.ts'
import { inv20 } from './inv20-server-boundary.ts'
import { inv21 } from './inv21-seam-import.ts'
import { inv22 } from './inv22-zustand-store.ts'
import { leakProjectInfo } from './leak-project-info.ts'
import { aq01 } from '../rules/AQ001-body-parse.ts'
import { aq02 } from '../rules/AQ002-status-bypass.ts'
import { aq03 } from '../rules/AQ003-catch-swallow.ts'
import { aq04 } from '../rules/AQ004-check-then-act.ts'
import { aq05 } from '../rules/AQ005-raw-sql-scope.ts'
import { aq06 } from '../rules/AQ006-route-auth.ts'
import { aq07 } from '../rules/AQ007-fake-green.ts'
import { aq08 } from '../rules/AQ008-idor.ts'
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
  leakProjectInfo,
  // 规则层（`qe/rules/`）：判据是纯函数，经 `lib/rule-guard.ts` 接到同一接口上
  aq01,
  aq02,
  aq03,
  aq04,
  aq05,
  aq06,
  aq07,
  aq08,
]
