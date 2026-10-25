'use client'

export function RecallButton(): null {
  async function run(): Promise<void> {
    await fetch('/api/recall', { method: 'POST' })
  }
  void run
  return null
}
