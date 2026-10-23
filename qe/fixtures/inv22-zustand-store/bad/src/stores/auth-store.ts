import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useAuthStore = create(
  persist(
    () => ({ token: '' }),
    {
      name: 'auth',
      version: 1,
      partialize: (state) => ({ token: state.token }),
    },
  ),
)
