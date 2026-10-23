import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useOrderFilterStore = create(
  persist(
    () => ({ keyword: '' }),
    {
      name: 'order-filters',
      version: 1,
      partialize: (state) => ({ keyword: state.keyword }),
    },
  ),
)
