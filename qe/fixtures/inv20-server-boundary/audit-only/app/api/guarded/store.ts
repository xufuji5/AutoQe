export function tenantRead<T>(session: unknown, fn: (tx: { batch: { findMany: (args: unknown) => Promise<T> } }) => Promise<T>) {
  return db.$transaction(async (tx) => fn(tx as { batch: { findMany: (args: unknown) => Promise<T> } }))
}
