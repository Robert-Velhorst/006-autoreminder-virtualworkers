import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import { shouldRetryQuery } from "./lib/query-retry";

const TRPC_REQUEST_TIMEOUT_MS = 30_000;
const API_REQUEST_TIMEOUT_MS = TRPC_REQUEST_TIMEOUT_MS;

const nativeFetch = globalThis.fetch.bind(globalThis);

function isSameOriginApiRequest(input: RequestInfo | URL) {
  const inputUrl = typeof input === 'string'
    ? input
    : input instanceof Request
      ? input.url
      : input.toString();
  const url = new URL(inputUrl, window.location.origin);
  return url.origin === window.location.origin && url.pathname.startsWith('/api/');
}

function fetchDashboardApiWithDeadline(input: RequestInfo | URL, init?: RequestInit) {
  if (!isSameOriginApiRequest(input)) return nativeFetch(input, init);

  const timeout = AbortSignal.timeout(API_REQUEST_TIMEOUT_MS);
  const requestSignal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return nativeFetch(input, { ...(init ?? {}), signal: requestSignal });
}

// Legacy UI modules still use fetch directly. Bound only same-origin API calls
// so those requests receive the same cancellation behavior as tRPC.
globalThis.fetch = fetchDashboardApiWithDeadline;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
      retryDelay: (attempt) => Math.min(1_000 * (attempt + 1), 5_000),
    },
    mutations: {
      retry: false,
    },
  },
});

// On 401, just reload the page — DashboardLayout will show the local login form
const handleExpectedUnauthenticatedError = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return false;
  if (typeof window === "undefined") return false;
  if (error.message !== UNAUTHED_ERR_MSG) return false;
  // Don't redirect to Manus OAuth — the login form is rendered by DashboardLayout
  queryClient.clear();
  return true;
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    if (handleExpectedUnauthenticatedError(error)) return;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    if (handleExpectedUnauthenticatedError(error)) return;
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        const timeout = AbortSignal.timeout(TRPC_REQUEST_TIMEOUT_MS);
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
          signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
