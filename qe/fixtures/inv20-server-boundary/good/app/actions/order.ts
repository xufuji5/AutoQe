'use server'

import { z } from 'zod'
import { requireUser } from '@/lib/auth'

const input = z.object({ totalCents: z.number().int().positive() })

export async function createOrder(formData: FormData): Promise<void> {
  await requireUser()
  input.parse({ totalCents: Number(formData.get('totalCents')) })
}
