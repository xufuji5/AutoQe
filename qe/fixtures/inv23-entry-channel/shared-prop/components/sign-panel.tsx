'use client'

export function SignPanel({ endpoint }: { endpoint: string }): null {
  async function submit(): Promise<void> {
    await fetch(endpoint, { method: 'POST' })
  }
  void submit
  return null
}
