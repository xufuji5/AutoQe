export async function createAccount(input: { name: string }) {
  return prisma.account.create({ data: { name: input.name } })
}
