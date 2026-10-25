import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useRequestFilterStore = create(
  persist(
    () => ({ keyword: '' }),
    {
      name: 'request-filters',
      version: 1,
      partialize: (state) => ({ keyword: state.keyword }),
    },
  ),
)
