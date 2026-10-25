'use client'

export function OrderForm(): null {
  async function submit(): Promise<void> {
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ sku: 'A-1' }) })
  }
  void submit
  return null
}
