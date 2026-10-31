import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useWaitForTransactionReceipt } from "wagmi";

import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import { useTxReceipt } from "@/hooks/useTxReceipt";
import { fetchSafeMultisigTx } from "@/lib/safe-tx-service";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
}));
vi.mock("@/hooks/useIsSafeWallet", () => ({ useIsSafeWallet: vi.fn() }));
// vitest.setup.ts stubs react-query globally; this hook needs the real polling.
vi.mock("@tanstack/react-query", async () => await vi.importActual("@tanstack/react-query"));

const SAFE = "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f";
// Real pair from the 31 Oct CVX approval: safeTxHash -> executed on-chain hash.
const SAFE_TX_HASH = "0x25bc99a3a5b83fb8f7e012607ddbfcd4b7b86cf167c15914459c8fea276b9963";
const EXEC_HASH = "0x6fcea8d7be7bbebfed30931674ea09fb669bb60b73797a2be2cb1951efebb9a4";

const mockUseAccount = vi.mocked(useAccount);
const mockUseIsSafeWallet = vi.mocked(useIsSafeWallet);
const mockWait = vi.mocked(useWaitForTransactionReceipt);

/** Only EXEC_HASH (and PLAIN_HASH) ever get a receipt; a safeTxHash never does. */
const MINED = new Set<string>([EXEC_HASH]);

function fakeWait(params?: { hash?: string; query?: { enabled?: boolean } }) {
  const enabled = (params?.query?.enabled ?? true) && Boolean(params?.hash);
  const mined = enabled && MINED.has(params!.hash!);
  return {
    data: mined ? { status: "success", transactionHash: params!.hash, blockNumber: 1n, gasUsed: 1n } : undefined,
    isLoading: enabled && !mined,
    isPending: !mined,
    isSuccess: mined,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
}

function serviceResponse(status: number, body?: object) {
  return new Response(body ? JSON.stringify(body) : null, { status });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useTxReceipt", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockUseAccount.mockReturnValue({ address: SAFE, chainId: 1 } as unknown as ReturnType<typeof useAccount>);
    mockWait.mockImplementation(fakeWait as unknown as typeof useWaitForTransactionReceipt);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("behaves like the wagmi hook for a non-Safe account and never calls the Safe service", () => {
    mockUseIsSafeWallet.mockReturnValue(false);
    const { result } = renderHook(() => useTxReceipt({ hash: EXEC_HASH }), { wrapper });

    expect(result.current.isSuccess).toBe(true);
    expect(result.current.safe).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps waiting while the Safe transaction still needs signatures", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockResolvedValue(serviceResponse(200, {
      transactionHash: null, isExecuted: false, isSuccessful: null,
      confirmations: [{}], confirmationsRequired: 2,
    }));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe).not.toBeNull());
    expect(result.current.safe).toMatchObject({ isAwaitingExecution: true, confirmations: 1, confirmationsRequired: 2 });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isSuccess).toBe(false);
  });

  it("confirms once the Safe executes, using the on-chain hash instead of the safeTxHash", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockResolvedValue(serviceResponse(200, {
      transactionHash: EXEC_HASH, isExecuted: true, isSuccessful: true,
      confirmations: [{}, {}], confirmationsRequired: 2,
    }));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.transactionHash).toBe(EXEC_HASH);
    expect(result.current.data?.status).toBe("success");
    expect(result.current.safe).toMatchObject({ isAwaitingExecution: false, executedHash: EXEC_HASH });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/${SAFE_TX_HASH}/`,
      expect.anything(),
    );
  });

  it("reports a reverted receipt when the Safe executed but the inner call failed", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockResolvedValue(serviceResponse(200, {
      transactionHash: EXEC_HASH, isExecuted: true, isSuccessful: false,
      confirmations: [{}, {}], confirmationsRequired: 2,
    }));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe("reverted");
  });

  it("falls back to the plain receipt when the Safe service doesn't know the hash", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockResolvedValue(serviceResponse(404));

    const { result } = renderHook(() => useTxReceipt({ hash: EXEC_HASH }), { wrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.safe).toBeNull();
  });
});

describe("fetchSafeMultisigTx", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects malformed hashes before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSafeMultisigTx(1, "0x1234/../evil")).rejects.toThrow("Invalid transaction hash");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on unsupported chains and service errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(serviceResponse(503)));
    await expect(fetchSafeMultisigTx(1337, SAFE_TX_HASH)).rejects.toThrow("No Safe Transaction Service");
    await expect(fetchSafeMultisigTx(1, SAFE_TX_HASH)).rejects.toThrow("503");
  });
});
