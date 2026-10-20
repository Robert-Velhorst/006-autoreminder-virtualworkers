import { renderToStaticMarkup } from "react-dom/server";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./useAuth";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  mutation: vi.fn(),
  mutateAsync: vi.fn(),
  cancel: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  replace: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: {
      cancel: mocks.cancel,
      setData: mocks.setData,
      invalidate: mocks.invalidate,
    } } }),
    auth: {
      me: { useQuery: mocks.me },
      logout: { useMutation: mocks.mutation },
    },
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderAuth() {
  let auth!: ReturnType<typeof useAuth>;
  function Probe() {
    auth = useAuth();
    return <span>{auth.loading ? "loading" : auth.user ? "verified" : "login"}</span>;
  }
  const markup = renderToStaticMarkup(<Probe />);
  return { auth, markup };
}

const user = { id: 7, name: "Founder", role: "admin" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { location: { replace: mocks.replace } });
  mocks.me.mockReturnValue({
    data: user,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: mocks.refetch,
  });
  mocks.mutation.mockReturnValue({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    error: null,
  });
  mocks.mutateAsync.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("useAuth logout", () => {
  it("awaits server revocation and query cancellation before navigating once", async () => {
    const server = deferred();
    const cancellation = deferred();
    mocks.mutateAsync.mockReturnValue(server.promise);
    mocks.cancel.mockReturnValue(cancellation.promise);
    const { auth, markup } = renderAuth();
    expect(markup).toContain("verified");

    const first = auth.logout();
    expect(auth.logout()).toBe(first);
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();

    server.resolve();
    await server.promise;
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
    cancellation.resolve();
    await first;
    await auth.logout();
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(mocks.setData).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.mutation).toHaveBeenCalledWith();
  });

  it("returns to login when the server reports an already revoked session", async () => {
    const error = new TRPCClientError("Session expired");
    Object.assign(error, { data: { code: "UNAUTHORIZED" } });
    mocks.mutateAsync.mockRejectedValue(error);
    await renderAuth().auth.logout();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(mocks.setData).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it.each([new Error("Network unavailable"), Object.assign(
    new TRPCClientError("Logout failed"),
    { data: { code: "INTERNAL_SERVER_ERROR" } },
  )])("preserves verified state and propagates logout failure: %s", async error => {
    mocks.mutateAsync.mockRejectedValueOnce(error);
    const { auth } = renderAuth();
    await expect(auth.logout()).rejects.toBe(error);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.setData).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(renderAuth().auth.user).toBe(user);

    await auth.logout();
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("keeps verification outages distinct from confirmed unauthenticated state", () => {
    const error = new Error("Session verification unavailable");
    mocks.me.mockReturnValue({ data: user, error, isFetching: true });
    const { auth } = renderAuth();
    expect(auth.user).toBe(user);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.verificationUnavailable).toBe(true);
    expect(auth.checking).toBe(true);
    expect(auth.error).toBe(error);
  });
});
