export async function saveAccount(input: { name: string }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('save_account'))`
    return tx.account.upsert({
      where: { name: input.name },
      update: {},
      create: { name: input.name },
    })
  })
}
