import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useSessionStore = create(
  persist(
    () => ({ accessToken: '', filter: 'all' }),
    { name: 'session', version: 1 },
  ),
)
