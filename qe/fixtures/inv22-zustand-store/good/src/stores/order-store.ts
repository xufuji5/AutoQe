import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface OrderState {
  orders: string[]
  add: (id: string) => void
}

export const useOrderStore = create<OrderState>()(
  persist(
    (set) => ({
      orders: [],
      add: (id) => set((s) => ({ orders: [...s.orders, id] })),
    }),
    {
      name: 'orders',
      version: 1,
      partialize: (state) => ({ orders: state.orders }),
    },
  ),
)
