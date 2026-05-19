// app/web/src/hooks/useAuth.ts
//
// `useAuth()` returns the current signed-in user and exposes signIn/signOut.
// Backed by React Query so callers across the tree share one cached value and
// re-render on cookie changes.
//
// `signIn` returns the raw login response — the Login component is responsible
// for branching on `mfa_required` vs `user`. We don't bury that branch here
// because the UI needs to morph into the MFA step rather than fail-and-retry.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuthHttpError,
  AuthLoginResponse,
  AuthMeResponse,
  AuthUser,
  LoginInput,
  MfaVerifyInput,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  mfaVerify as apiMfaVerify,
} from '../lib/auth-api';

export const AUTH_ME_KEY = ['auth', 'me'] as const;

export interface UseAuthResult {
  user: AuthUser | null;
  isLoading: boolean;
  isAdmin: boolean;
  error: AuthHttpError | null;
  signIn: (input: LoginInput) => Promise<AuthLoginResponse>;
  signInPending: boolean;
  signInError: AuthHttpError | null;
  verifyMfa: (input: MfaVerifyInput) => Promise<AuthMeResponse>;
  verifyMfaPending: boolean;
  verifyMfaError: AuthHttpError | null;
  signOut: () => Promise<void>;
  signOutPending: boolean;
  refetch: () => Promise<unknown>;
}

export function useAuth(): UseAuthResult {
  const qc = useQueryClient();

  const meQuery = useQuery<AuthMeResponse | null, AuthHttpError>({
    queryKey: AUTH_ME_KEY,
    queryFn: apiMe,
    staleTime: 30_000,
    retry: false,
  });

  const signInMut = useMutation<AuthLoginResponse, AuthHttpError, LoginInput>({
    mutationFn: apiLogin,
    onSuccess: async (result) => {
      if ('user' in result) {
        qc.setQueryData<AuthMeResponse>(AUTH_ME_KEY, { user: result.user });
        await qc.invalidateQueries({ queryKey: AUTH_ME_KEY });
      }
    },
  });

  const verifyMfaMut = useMutation<AuthMeResponse, AuthHttpError, MfaVerifyInput>({
    mutationFn: apiMfaVerify,
    onSuccess: async (result) => {
      qc.setQueryData<AuthMeResponse>(AUTH_ME_KEY, result);
      await qc.invalidateQueries({ queryKey: AUTH_ME_KEY });
    },
  });

  const signOutMut = useMutation<void, AuthHttpError, void>({
    mutationFn: apiLogout,
    onSettled: async () => {
      qc.setQueryData<AuthMeResponse | null>(AUTH_ME_KEY, null);
      await qc.invalidateQueries({ queryKey: AUTH_ME_KEY });
      // Drop all cached data — the next sign-in will repopulate.
      qc.clear();
    },
  });

  const user = meQuery.data?.user ?? null;
  return {
    user,
    isLoading: meQuery.isLoading,
    isAdmin: user?.role === 'admin',
    error: meQuery.error ?? null,
    signIn: (input) => signInMut.mutateAsync(input),
    signInPending: signInMut.isLoading,
    signInError: signInMut.error ?? null,
    verifyMfa: (input) => verifyMfaMut.mutateAsync(input),
    verifyMfaPending: verifyMfaMut.isLoading,
    verifyMfaError: verifyMfaMut.error ?? null,
    signOut: async () => {
      await signOutMut.mutateAsync();
    },
    signOutPending: signOutMut.isLoading,
    refetch: () => meQuery.refetch(),
  };
}
