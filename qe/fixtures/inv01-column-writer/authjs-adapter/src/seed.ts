import { prisma } from './client.ts'

export async function createUser(email: string): Promise<unknown> {
  return prisma.user.create({ data: { email } })
}
