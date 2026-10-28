/**
 * 越界留痕：只在拒绝路径写一条审计行。函数名必须命中 `auditWriteCalls`
 * （默认含 `logAccessDeny`），否则会被当成业务写，把只读出口报成重复证据。
 */
export async function logAccessDeny(
  actor: unknown,
  meta: { attempted: string; targetId?: string },
): Promise<void> {
  await db.$transaction((tx) =>
    tx.auditEvent.create({
      data: { action: 'access.deny', attempted: meta.attempted, targetId: meta.targetId ?? null, actor },
    }),
  )
}
