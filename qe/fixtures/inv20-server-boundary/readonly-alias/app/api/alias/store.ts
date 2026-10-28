export function readRows(tx: { batch: { findMany: (args: unknown) => Promise<unknown> } }, tenantId: string) {
  return tx.batch.findMany({ where: { tenantId } })
}

/**
 * 导出别名：`export const readOnly = readRows` 不是函数声明，`exportedFunctions` 抓不到。
 * 调用方会因此被判 `no-export`（假盲区）→ 被迫报「写痕迹未出现」；
 * 别名指向同文件真实函数时可见性并没有丢，守卫应跟进去看。
 */
export const readOnly: typeof readRows = readRows
