'use client'

export function SupportList(): null {
  async function load(): Promise<void> {
    await fetch('/api/support')
  }
  void load
  return null
}
