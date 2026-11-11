import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toEventSelector } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useWaitForTransactionReceipt } from "wagmi";

import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import { useTxReceipt } from "@/hooks/useTxReceipt";
import { fetchSafeMultisigTx, safeExecutionVerdict } from "@/lib/safe-tx-service";

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

/** The Safe's own verdict events, as the mined receipt would carry them. */
const EXECUTION_SUCCESS_TOPIC = toEventSelector("ExecutionSuccess(bytes32,uint256)");
const EXECUTION_FAILURE_TOPIC = toEventSelector("ExecutionFailure(bytes32,uint256)");

/** Receipt logs for a mined hash; tests add them so the receipt carries a verdict. */
const receiptLogs = new Map<string, { address: string; topics: string[]; data?: string }[]>();

/** An event with the safeTxHash indexed (topic 1) and a payment word. */
function safeLog(topic: string, address = SAFE, safeTxHash = SAFE_TX_HASH) {
  return { address, topics: [topic, safeTxHash, `0x${"00".repeat(32)}`] };
}

/** An event with the safeTxHash as the first 32 bytes of data instead of a topic. */
function safeLogData(topic: string, safeTxHash = SAFE_TX_HASH, address = SAFE) {
  return { address, topics: [topic], data: `${safeTxHash}${"00".repeat(32)}` };
}

function fakeWait(params?: { hash?: string; query?: { enabled?: boolean } }) {
  const enabled = (params?.query?.enabled ?? true) && Boolean(params?.hash);
  const mined = enabled && MINED.has(params!.hash!);
  const logs = params?.hash ? receiptLogs.get(params.hash) : undefined;
  return {
    data: mined
      ? { status: "success", transactionHash: params!.hash, blockNumber: 1n, gasUsed: 1n, ...(logs ? { logs } : {}) }
      : undefined,
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
    vi.useRealTimers();
    receiptLogs.clear();
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

  /** A service reply for a tx the Safe already executed; fresh response per call. */
  function executedReply(isSuccessful: boolean | null) {
    return serviceResponse(200, {
      safe: SAFE, transactionHash: EXEC_HASH, isExecuted: true, isSuccessful,
      confirmations: [{}, {}], confirmationsRequired: 2,
    });
  }

  /** Flush pending query notifications and the React work they trigger. */
  async function settle() {
    await act(async () => {
      // react-query defers its cache and subscriber notifications with a real
      // setTimeout(0), so one poll's result takes a few ticks to reach React.
      for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(1);
    });
  }

  /** Advance past the service poll interval (SAFE_POLL_MS) `times` times. */
  async function pollService(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        // react-query hands its subscriber notifications to a real setTimeout(0).
        await vi.advanceTimersByTimeAsync(1);
      });
    }
  }

  it("doesn't report success while the service has no inner-call verdict yet", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(null));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe?.executedHash).toBe(EXEC_HASH));
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it("reports a reverted receipt when the service indexes the failure on a later poll", async () => {
    vi.useFakeTimers();
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementationOnce(async () => executedReply(null));
    fetchMock.mockImplementation(async () => executedReply(false));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await settle();
    expect(result.current.safe?.executedHash).toBe(EXEC_HASH);
    expect(result.current.isSuccess).toBe(false);

    await pollService();
    expect(result.current.data?.status).toBe("reverted");
  });

  it("confirms when the service indexes the success on a later poll", async () => {
    vi.useFakeTimers();
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementationOnce(async () => executedReply(null));
    fetchMock.mockImplementation(async () => executedReply(true));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await settle();
    expect(result.current.isSuccess).toBe(false);

    await pollService();
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data?.status).toBe("success");
  });

  it("reverts at once on the Safe's ExecutionFailure log, before the service has a verdict", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(null));
    receiptLogs.set(EXEC_HASH, [safeLog(EXECUTION_FAILURE_TOPIC)]);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.data?.status).toBe("reverted"));
  });

  it("confirms at once on the Safe's ExecutionSuccess log, before the service has a verdict", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(null));
    // This event carries the safeTxHash in its data rather than in topic 1.
    receiptLogs.set(EXEC_HASH, [safeLogData(EXECUTION_SUCCESS_TOPIC)]);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("success");
  });

  it("ignores a verdict event for a different Safe transaction", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(true));
    // Same Safe, but the event belongs to another safeTxHash.
    receiptLogs.set(EXEC_HASH, [safeLog(EXECUTION_FAILURE_TOPIC, SAFE, `0x${"cd".repeat(32)}`)]);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Falls through to the service's own field: success, not the other tx's failure.
    expect(result.current.data?.status).toBe("success");
  });

  it("stops waiting once the wall-clock wait is over, even when the service keeps failing", async () => {
    vi.useFakeTimers();
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementationOnce(async () => executedReply(null));
    fetchMock.mockImplementation(async () => serviceResponse(500));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await settle();
    expect(result.current.safe?.executedHash).toBe(EXEC_HASH);
    expect(result.current.isSuccess).toBe(false);

    // The receipt carries no Safe event, so only the time bound can settle it.
    await pollService(11);
    await settle();
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data?.status).toBe("success");
  });

  it("trusts the Safe's ExecutionFailure log over a reported success", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(true));
    receiptLogs.set(EXEC_HASH, [safeLog(EXECUTION_FAILURE_TOPIC)]);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.data?.status).toBe("reverted"));
  });

  it("ignores an ExecutionFailure log from another address", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(null));
    receiptLogs.set(EXEC_HASH, [safeLog(EXECUTION_FAILURE_TOPIC, "0x1111111111111111111111111111111111111111")]);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe?.executedHash).toBe(EXEC_HASH));
    // Still inconclusive: neither the logs nor the service give a verdict.
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("accepts the on-chain receipt once the verdict stays unavailable for too long", async () => {
    vi.useFakeTimers();
    mockUseIsSafeWallet.mockReturnValue(true);
    fetchMock.mockImplementation(async () => executedReply(null));

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await settle();
    expect(result.current.isSuccess).toBe(false);

    // One poll short of VERDICT_POLLS_BEFORE_ACCEPTING = 10: still not success.
    await pollService(9);
    expect(result.current.isSuccess).toBe(false);

    await pollService(1);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data?.status).toBe("success");

    const fetchesAfterAccepting = fetchMock.mock.calls.length;
    await pollService(3);
    expect(fetchMock.mock.calls.length).toBe(fetchesAfterAccepting);
  });

  /** Safe service by URL: the pending tx is nonce 5; the Safe is now at `safeNonce`. */
  function mockSafeService(safeNonce: number, executedAtNonce5?: { safeTxHash?: string; to: string; value: string; data: string | null }) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/multisig-transactions/" + SAFE_TX_HASH)) {
        return serviceResponse(200, {
          safe: SAFE, nonce: 5, transactionHash: null, isExecuted: false, isSuccessful: null,
          confirmations: [{}], confirmationsRequired: 2,
        });
      }
      if (url.endsWith(`/safes/${SAFE}/`)) return serviceResponse(200, { nonce: safeNonce });
      if (url.includes(`/safes/${SAFE}/multisig-transactions/?nonce=5&executed=true`)) {
        return serviceResponse(200, { results: executedAtNonce5 ? [executedAtNonce5] : [] });
      }
      return serviceResponse(404);
    });
  }

  it("stops waiting and reports an error when the owners rejected the tx (same nonce)", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    mockSafeService(6, { to: SAFE.toLowerCase(), value: "0", data: null });

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe?.outcome).toBe("rejected"));
    expect(result.current.safe?.isAwaitingExecution).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(true);
    expect(result.current.error?.message).toMatch(/rejected in your Safe/);
  });

  it("reports 'replaced' when another tx executed at its nonce", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    mockSafeService(6, { to: "0x1111111111111111111111111111111111111111", value: "0", data: "0xa9059cbb" });

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe?.outcome).toBe("replaced"));
    expect(result.current.error?.message).toMatch(/replaced in your Safe/);
  });

  it("doesn't call our own just-executed tx 'replaced' while the service catches up", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    // Nonce moved past, and the executed tx at that nonce is ours (no transactionHash on ours yet).
    mockSafeService(6, { safeTxHash: SAFE_TX_HASH, to: "0x1111111111111111111111111111111111111111", value: "0", data: "0xa9059cbb" } as never);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe).not.toBeNull());
    expect(result.current.safe).toMatchObject({ isAwaitingExecution: true, outcome: null });
    expect(result.current.isError).toBe(false);
  });

  it("keeps waiting when no executed tx is listed at the nonce yet", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    mockSafeService(6);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe).not.toBeNull());
    expect(result.current.safe).toMatchObject({ isAwaitingExecution: true, outcome: null });
  });

  it("keeps waiting while the Safe's nonce hasn't moved past the tx", async () => {
    mockUseIsSafeWallet.mockReturnValue(true);
    mockSafeService(5);

    const { result } = renderHook(() => useTxReceipt({ hash: SAFE_TX_HASH }), { wrapper });

    await waitFor(() => expect(result.current.safe).not.toBeNull());
    expect(result.current.safe).toMatchObject({ isAwaitingExecution: true, outcome: null });
    expect(result.current.isLoading).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("executed=true"))).toBe(false);
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

  it("carries the Safe's own address, needed to read its verdict logs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(serviceResponse(200, {
      safe: SAFE, nonce: 5, transactionHash: EXEC_HASH, isExecuted: true, isSuccessful: null,
      confirmations: [], confirmationsRequired: 2,
    })));
    const lookup = await fetchSafeMultisigTx(1, SAFE_TX_HASH);
    expect(lookup).toMatchObject({ kind: "safe", safe: SAFE.toLowerCase() });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(serviceResponse(200, {
      transactionHash: EXEC_HASH, isExecuted: true, isSuccessful: true,
    })));
    const withoutSafe = await fetchSafeMultisigTx(1, SAFE_TX_HASH);
    expect(withoutSafe).toMatchObject({ kind: "safe", safe: null });
  });
});

describe("safeExecutionVerdict", () => {
  const other = "0x1111111111111111111111111111111111111111";

  it("decides from the Safe's own logs before the service field", () => {
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_FAILURE_TOPIC)], isSuccessful: true })).toBe("failed");
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_SUCCESS_TOPIC)], isSuccessful: false })).toBe("succeeded");
  });

  it("reads the safeTxHash from the data when the event has no second topic", () => {
    expect(safeExecutionVerdict({
      safe: SAFE,
      safeTxHash: SAFE_TX_HASH,
      logs: [safeLogData(EXECUTION_FAILURE_TOPIC)],
      isSuccessful: true,
    })).toBe("failed");
  });

  it("matches the Safe's address, the safeTxHash and the topic regardless of case", () => {
    const upper = (value: string) => value.toUpperCase().replace("0X", "0x");
    const logs = [{ address: upper(SAFE), topics: [upper(EXECUTION_FAILURE_TOPIC), upper(SAFE_TX_HASH)] }];
    expect(safeExecutionVerdict({ safe: SAFE.toLowerCase(), safeTxHash: SAFE_TX_HASH.toLowerCase(), logs, isSuccessful: null })).toBe("failed");
  });

  it("ignores an event for another Safe transaction", () => {
    const otherHash = `0x${"cd".repeat(32)}`;
    expect(safeExecutionVerdict({
      safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_FAILURE_TOPIC, SAFE, otherHash)], isSuccessful: true,
    })).toBe("succeeded");
    expect(safeExecutionVerdict({
      safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_FAILURE_TOPIC, SAFE, otherHash)], isSuccessful: null,
    })).toBe("unknown");
  });

  it("ignores an event that carries no transaction hash", () => {
    const logs = [{ address: SAFE, topics: [EXECUTION_FAILURE_TOPIC] }];
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs, isSuccessful: null })).toBe("unknown");
  });

  it("ignores events from other contracts", () => {
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_FAILURE_TOPIC, other)], isSuccessful: true })).toBe("succeeded");
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_FAILURE_TOPIC, other)], isSuccessful: null })).toBe("unknown");
  });

  it("falls back to the service field when the logs carry no Safe event", () => {
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [], isSuccessful: true })).toBe("succeeded");
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [], isSuccessful: false })).toBe("failed");
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: undefined, isSuccessful: null })).toBe("unknown");
  });

  it("cannot read logs without the Safe's address", () => {
    expect(safeExecutionVerdict({ safe: null, safeTxHash: SAFE_TX_HASH, logs: [safeLog(EXECUTION_FAILURE_TOPIC)], isSuccessful: null })).toBe("unknown");
  });

  it("treats an unrelated log topic as no verdict", () => {
    expect(safeExecutionVerdict({ safe: SAFE, safeTxHash: SAFE_TX_HASH, logs: [safeLog(`0x${"ab".repeat(32)}`)], isSuccessful: null })).toBe("unknown");
  });
});
