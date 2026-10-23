import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useFilterStore = create(
  persist(() => ({ keyword: '' }), { name: 'filters' }),
)
