import { inv01 } from './inv01-column-writer.ts'
import { inv02 } from './inv02-column-reader.ts'
import { inv03 } from './inv03-dead-enum.ts'
import { inv06 } from './inv06-promise-backing.ts'
import { inv07 } from './inv07-gate-control.ts'
import { inv13 } from './inv13-addressable.ts'
import { inv20 } from './inv20-server-boundary.ts'
import { inv21 } from './inv21-seam-import.ts'
import { inv22 } from './inv22-zustand-store.ts'
import type { Guard } from '../lib/guard.ts'

/** 守卫单表：新增守卫必须在此登记，否则 inv13 报孤儿 */
export const guards: Guard[] = [inv01, inv02, inv03, inv06, inv07, inv13, inv20, inv21, inv22]
