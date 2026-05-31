import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  userId: string | null;
  name: string | null;
  isAuthenticated: boolean;
  login: (userId: string, name: string, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      userId: null,
      name: null,
      isAuthenticated: false,
      login: (userId, name, token) =>
        set({ token, userId, name, isAuthenticated: true }),
      logout: () =>
        set({ token: null, userId: null, name: null, isAuthenticated: false }),
    }),
    { name: 'loony-s3-auth' },
  ),
);
