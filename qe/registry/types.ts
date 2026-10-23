/**
 * 不变量注册表类型（单源）。
 * 纪律：
 *  - 条目只活在这里，文档只写方法与指针（禁止第二份清单）。
 *  - enforced 必须同时具备 guard 与 badSample；partial 必须写 gap；open 必须写 openReason + revisitBy。
 *  - defectClasses 只能取 58 号 §一 的九类词汇，禁止发明第十类。
 */

export type InvariantStatus = 'enforced' | 'partial' | 'open'

export type DefectClass =
  | '漂移'
  | '接缝'
  | '登记制失效'
  | '建了没接线'
  | '隐性陷阱'
  | '证据不足'
  | '测试方法论'
  | '并发正确性'
  | '防线幻觉'

export interface Invariant {
  /** INV-CORE-01 形式，号段唯一 */
  id: string
  /** 一句话，主语是系统 */
  statement: string
  defectClasses: DefectClass[]
  /** 守卫的 npm 别名（enforced/partial 必填），必须能在 package.json scripts 中寻址 */
  guard?: string
  /** 坏样本位置或描述（enforced 必填），缺了不许标 enforced */
  badSample?: string
  status: InvariantStatus
  /** partial 必填：差在哪 */
  gap?: string
  /** open 必填：为什么守不住 / 谁能裁 */
  openReason?: string
  /** open 必填：复审日期（≤90 天），到点未处理转红 */
  revisitBy?: string
  /** 归并来源：历史缺陷编号 */
  c7?: string[]
  decidedAt?: string
}

export const DEFECT_CLASSES: readonly DefectClass[] = [
  '漂移',
  '接缝',
  '登记制失效',
  '建了没接线',
  '隐性陷阱',
  '证据不足',
  '测试方法论',
  '并发正确性',
  '防线幻觉',
]
