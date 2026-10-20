import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useMemo, useRef, useState } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  // redirectOnUnauthenticated is intentionally ignored — DashboardLayout
  // renders the local login form when user is null, no redirect needed.
  const utils = trpc.useUtils();
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutInFlight = useRef<Promise<void> | null>(null);

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    // Retry only the read-only session check; never repeat a submitted action.
    refetchInterval: query => query.state.error ? 5_000 : query.state.data ? 60_000 : false,
  });

  const logoutMutation = trpc.auth.logout.useMutation();

  const logout = useCallback(() => {
    if (logoutInFlight.current) return logoutInFlight.current;
    setLoggingOut(true);
    const pending = (async () => {
      try {
        await logoutMutation.mutateAsync();
      } catch (error: unknown) {
        if (
          !(error instanceof TRPCClientError) ||
          error.data?.code !== "UNAUTHORIZED"
        ) {
          throw error;
        }
      }
      // Keep the current screen gated until navigation replaces this document.
      // Do not expose login or refetch the revoked session in the old document.
      await utils.auth.me.cancel();
      window.location.replace("/");
    })().catch((error: unknown) => {
      logoutInFlight.current = null;
      setLoggingOut(false);
      throw error;
    });
    logoutInFlight.current = pending;
    return pending;
  }, [logoutMutation, utils]);

  const state = useMemo(() => {
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending || loggingOut,
      checking: meQuery.isFetching,
      verificationUnavailable: Boolean(meQuery.error),
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    meQuery.isFetching,
    logoutMutation.error,
    logoutMutation.isPending,
    loggingOut,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
