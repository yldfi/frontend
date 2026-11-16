import type { ReactNode } from "react";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useBalance, useBlockNumber, useGasPrice, usePublicClient } from "wagmi";

import { ZapPageContent } from "@/components/ZapPageContent";
import { useSettings } from "@/hooks/useSettings";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useUniversalZap } from "@/hooks/useUniversalZap";
import { useZapActions } from "@/hooks/useZapActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { ETH_ADDRESS } from "@/lib/enso";
import { toast } from "sonner";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import type { SimulationResult, ZapQuote } from "@/types/enso";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useBalance: vi.fn(),
  useBlockNumber: vi.fn(),
  useGasPrice: vi.fn(),
  usePublicClient: vi.fn(),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: vi.fn(),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: vi.fn(),
}));

vi.mock("@/hooks/useUniversalZap", () => ({
  useUniversalZap: vi.fn(),
}));

vi.mock("@/hooks/useZapActions", () => ({
  useZapActions: vi.fn(),
}));

vi.mock("@/hooks/useTokenBalances", () => ({
  useTokenBalances: vi.fn(),
}));

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/components/Header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@/components/Footer", () => ({
  Footer: () => <div data-testid="footer" />,
}));

vi.mock("@/components/TokenSelector", () => ({
  TokenSelector: ({ selectedToken }: { selectedToken: { symbol: string } }) => (
    <div data-testid={`token-${selectedToken.symbol}`}>{selectedToken.symbol}</div>
  ),
}));

vi.mock("@/components/MaxButton", () => ({
  MaxButton: ({ onSelect }: { onSelect: (value: string) => void }) => (
    <button type="button" onClick={() => onSelect("1")}>MAX</button>
  ),
}));

vi.mock("@/components/ApprovalCard", () => ({
  ApprovalCard: ({ show, onApprove }: { show: boolean; onApprove: (exact: boolean) => void }) =>
    show ? <button type="button" onClick={() => onApprove(true)}>Approve</button> : null,
}));

vi.mock("@/components/LoadingDots", () => ({
  LoadingDots: () => <span data-testid="loading-dots">...</span>,
}));

vi.mock("@/components/RouteDisplay", () => ({
  RouteDisplay: ({ routeInfo, isLoading, errorMessage }: { routeInfo?: unknown; isLoading?: boolean; errorMessage?: string }) => (
    <div data-testid="route-display" data-has-route={routeInfo ? "true" : "false"} data-loading={isLoading ? "true" : "false"} data-error={errorMessage ?? ""} />
  ),
}));

vi.mock("@/components/SlippageModal", () => ({
  SlippageModal: ({
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  }) => (open ? <button type="button" onClick={onClose}>Close settings</button> : null),
}));

vi.mock("@/components/SimulationModal", () => ({
  SimulationModal: ({
    isOpen,
    onConfirm,
    onClose,
    confirmText,
    ethPrice,
    simulationResult,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    onClose: () => void;
    confirmText?: string;
    ethPrice?: number | null;
    simulationResult?: { simulationUnavailable?: boolean; simulationUnavailableReason?: string };
  }) => isOpen ? (
    <div
      data-testid="simulation-modal"
      data-eth-price={ethPrice ?? ""}
      data-simulation-unavailable={simulationResult?.simulationUnavailable ? "true" : "false"}
      data-simulation-unavailable-reason={simulationResult?.simulationUnavailableReason ?? ""}
    >
      <button type="button" onClick={onConfirm}>{confirmText ?? "Confirm"}</button>
      <button type="button" onClick={onClose}>Close simulation</button>
    </div>
  ) : null,
}));

const mockUseAccount = vi.mocked(useAccount);
const mockUseBalance = vi.mocked(useBalance);
const mockUseBlockNumber = vi.mocked(useBlockNumber);
const mockUseGasPrice = vi.mocked(useGasPrice);
const mockUsePublicClient = vi.mocked(usePublicClient);
const mockUseConnectModal = vi.mocked(useConnectModal);
const mockUseSettings = vi.mocked(useSettings);
const mockUseUniversalZap = vi.mocked(useUniversalZap);
const mockUseZapActions = vi.mocked(useZapActions);
const mockUseTokenBalances = vi.mocked(useTokenBalances);
const mockUseDebouncedValue = vi.mocked(useDebouncedValue);

describe("ZapPageContent", () => {
  const executeZap = vi.fn(async () => null);
  const approve = vi.fn();
  const reset = vi.fn();
  const toggleRoute = vi.fn();
  const updateSlippage = vi.fn();
  const setShowSlippageModal = vi.fn();
  const refreshSimulationPreview = vi.fn();
  const setShowSimulationModal = vi.fn();
  const refetchBalance = vi.fn();
  const refetchAllowance = vi.fn();
  const refetchQuote = vi.fn(async () => ({ data: quote, error: null, isError: false, isPending: false, isLoading: false, isLoadingError: false, isRefetchError: false, isSuccess: true, isPlaceholderData: false, status: "success", dataUpdatedAt: 0, errorUpdatedAt: 0, failureCount: 0, failureReason: null, errorUpdateCount: 0, isFetched: true, isFetchedAfterMount: true, isFetching: false, isInitialLoading: false, isPaused: false, isRefetching: false, isStale: false, promise: Promise.resolve(quote), refetch: vi.fn(), remove: vi.fn(), fetchStatus: "idle", queryKey: [] }));
  const toggleFlashbots = vi.fn();

  const quote: ZapQuote = {
    inputToken: {
      address: ETH_ADDRESS,
      chainId: 1,
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
      type: "base",
    },
    inputAmount: "0.1",
    outputAmount: "5055400000000000000",
    outputAmountFormatted: "5.0554",
    exchangeRate: 650.0387,
    inputUsdValue: 18.35,
    outputUsdValue: 18.35,
    priceImpact: 2.11,
    gasEstimate: "200000",
    tx: {
      to: "0x1111111111111111111111111111111111111111",
      data: "0xabcdef",
      value: "0",
    },
    routeInfo: {
      steps: [
        { tokenSymbol: "ETH", action: "Swap", description: "for CVX", protocol: "Enso" },
        { tokenSymbol: "uCVX", action: "Receive", description: "vault shares", protocol: "Llama Airforce" },
      ],
    },
    route: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(localStorage.getItem).mockReset();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/zap");

    mockUseAccount.mockReturnValue({
      address: "0x1234567890123456789012345678901234567890",
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);

    mockUseBalance.mockReturnValue({
      data: { value: 10n ** 18n },
      refetch: refetchBalance,
    } as unknown as ReturnType<typeof useBalance>);

    mockUseGasPrice.mockReturnValue({
      data: 1n,
    } as ReturnType<typeof useGasPrice>);

    mockUseBlockNumber.mockReturnValue({
      data: 1n,
    } as ReturnType<typeof useBlockNumber>);

    mockUsePublicClient.mockReturnValue({
      readContract: vi.fn(async () => [0n, 100_000_000n]),
    } as unknown as ReturnType<typeof usePublicClient>);

    mockUseConnectModal.mockReturnValue({
      connectModalOpen: false,
      openConnectModal: vi.fn(),
    } as unknown as ReturnType<typeof useConnectModal>);

    mockUseSettings.mockReturnValue({
      slippage: "50",
      updateSlippage,
      showSlippageModal: false,
      setShowSlippageModal,
      showSimulationPreview: false,
      refreshSimulationPreview,
      showSimulationModal: false,
      setShowSimulationModal,
      showRoute: true,
      toggleRoute,
      setShowSimulationPreview: vi.fn(),
    });

    mockUseUniversalZap.mockReturnValue({
      quote,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);

    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "idle",
      error: null,
      isLoading: false,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: null,
      batchesApproval: false,
      isSimulationForCurrentQuote: () => true,
      simulationResult: null,
    } as ReturnType<typeof useZapActions>);

    mockUseTokenBalances.mockReturnValue({
      sortedTokens: [],
      balanceMap: new Map([[ETH_ADDRESS.toLowerCase(), 10n ** 18n]]),
      priceMap: new Map(),
      refetch: vi.fn(),
      refetchOnchain: vi.fn(),
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);

    mockUseDebouncedValue.mockImplementation((value) => value);
  });

  it("loads an auction payment target from the URL", () => {
    window.history.replaceState(
      {},
      "",
      `/zap?input=${ETH_ADDRESS}&output=${TOKENS.CVX}&outputAmount=150&outputLogo=https%3A%2F%2Fexample.invalid%2Fcvx.png`,
    );

    render(<ZapPageContent />);

    expect(screen.getByTestId("token-ETH")).toBeTruthy();
    expect(screen.getByTestId("token-CVX")).toBeTruthy();
    expect(mockUseTokenBalances).toHaveBeenCalledWith(
      [
        expect.objectContaining({ symbol: "ETH" }),
        expect.objectContaining({
          address: TOKENS.CVX,
          symbol: "CVX",
          logoURI: "/tokens/cvx.png",
        }),
      ],
      { preferOnchain: true, fetchPrices: false },
    );
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("1");
    expect(screen.getByText("150")).toBeTruthy();
  });

  it("ignores token metadata supplied in the URL", () => {
    const unknownAddress = "0x000000000000000000000000000000000000dead";
    window.history.replaceState(
      {},
      "",
      `/zap?input=${ETH_ADDRESS}&output=${unknownAddress}&outputSymbol=USDC&outputDecimals=6&outputLogo=https%3A%2F%2Fexample.invalid%2Fx.png`,
    );

    render(<ZapPageContent />);

    const calls = mockUseTokenBalances.mock.calls;
    const tokens = calls[calls.length - 1][0] as { address: string; symbol: string }[];
    expect(tokens[1].address.toLowerCase()).not.toBe(unknownAddress.toLowerCase());
    expect(tokens[1].symbol).not.toBe("USDC");
    expect(document.querySelector('img[src*="example.invalid"]')).toBeNull();
  });

  it("does not let the URL relabel a known token", () => {
    window.history.replaceState(
      {},
      "",
      `/zap?input=${ETH_ADDRESS}&output=${TOKENS.CVX}&outputSymbol=USDC&outputDecimals=6`,
    );

    render(<ZapPageContent />);

    const calls = mockUseTokenBalances.mock.calls;
    const tokens = calls[calls.length - 1][0] as { address: string; symbol: string; decimals: number }[];
    expect(tokens[1]).toEqual(
      expect.objectContaining({ address: TOKENS.CVX, symbol: "CVX", decimals: 18 }),
    );
  });

  it.each([null, "", "0", "0.000", "-1", "abc", "1e3", "1.2.3", "9".repeat(400)])("ignores invalid auction target %s and displays the initial quote", (target) => {
    const targetParam = target === null ? "" : `&outputAmount=${encodeURIComponent(target)}`;
    window.history.replaceState({}, "", `/zap?input=${ETH_ADDRESS}&output=${TOKENS.CVXCRV}${targetParam}`);
    mockUseUniversalZap.mockReturnValue({
      quote: { ...quote, inputAmount: "1" },
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);

    render(<ZapPageContent />);

    const input = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    expect(input.value).toBe("1");
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(expect.objectContaining({ inputAmount: "1" }));

    for (const routeDisplay of screen.getAllByTestId("route-display")) {
      expect(routeDisplay.getAttribute("data-has-route")).toBe("true");
      expect(routeDisplay.getAttribute("data-loading")).toBe("false");
    }
  });

  it("does not flash provisional route details while calibrating an auction target", () => {
    window.history.replaceState(
      {},
      "",
      `/zap?input=${ETH_ADDRESS}&output=${TOKENS.CVX}&outputAmount=150`,
    );
    mockUseUniversalZap.mockReturnValue({
      quote: {
        ...quote,
        inputAmount: "1",
        outputAmountFormatted: "1000",
      },
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);

    render(<ZapPageContent />);

    for (const routeDisplay of screen.getAllByTestId("route-display")) {
      expect(routeDisplay.getAttribute("data-has-route")).toBe("false");
      expect(routeDisplay.getAttribute("data-loading")).toBe("true");
    }
  });

  it("runs preview mode instead of sending immediately when simulation preview is enabled", async () => {
    mockUseSettings.mockReturnValue({
      slippage: "50",
      updateSlippage,
      showSlippageModal: false,
      setShowSlippageModal,
      showSimulationPreview: true,
      refreshSimulationPreview,
      showSimulationModal: false,
      setShowSimulationModal,
      showRoute: true,
      toggleRoute,
      setShowSimulationPreview: vi.fn(),
    });

    render(<ZapPageContent />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));

    await waitFor(() => {
      expect(executeZap).toHaveBeenCalledWith({ previewOnly: true });
    });
    // A null preview (approval needed or read failed) must not fall through to send.
    expect(executeZap).toHaveBeenCalledTimes(1);
  });

  it("sends directly when simulation preview is disabled", async () => {
    render(<ZapPageContent />);

    expect(mockUseTokenBalances).toHaveBeenCalledWith(
      [
        expect.objectContaining({ symbol: "ETH" }),
        expect.objectContaining({ symbol: "yscvxCRV" }),
      ],
      { preferOnchain: true, fetchPrices: false },
    );

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));

    await waitFor(() => {
      expect(executeZap).toHaveBeenCalledWith();
    });
  });

  it("refreshes instead of sending when the quote is older than 90 s", async () => {
    mockUseUniversalZap.mockReturnValue({
      quote,
      quoteUpdatedAt: Date.now() - 120_000,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    render(<ZapPageContent />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));

    await waitFor(() => expect(refetchQuote).toHaveBeenCalled());
    expect(executeZap).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it("sends a quote fetched within 90 s", async () => {
    mockUseUniversalZap.mockReturnValue({
      quote,
      quoteUpdatedAt: Date.now() - 30_000,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    render(<ZapPageContent />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));

    await waitFor(() => expect(executeZap).toHaveBeenCalledWith());
  });

  it("treats a re-typed equal amount as the same quote", async () => {
    render(<ZapPageContent />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.10" } });

    const zapButton = screen.getByRole("button", { name: "Zap" }) as HTMLButtonElement;
    expect(zapButton.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /Getting quote/ })).toBeNull();

    fireEvent.click(zapButton);
    await waitFor(() => expect(executeZap).toHaveBeenCalled());
  });

  it("passes the quote time and a stale-quote handler to the action hook", () => {
    mockUseUniversalZap.mockReturnValue({
      quote,
      quoteUpdatedAt: 123,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    render(<ZapPageContent />);

    const calls = mockUseZapActions.mock.calls;
    const freshness = calls[calls.length - 1]?.[1];
    expect(freshness).toMatchObject({
      quoteUpdatedAt: 123,
      onStaleQuote: expect.any(Function),
    });

    freshness?.onStaleQuote?.({ afterApproval: false });

    expect(refetchQuote).toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Quote refreshed. Check the new amounts, then try again.");
  });

  it("says the approval went through when the quote is refreshed after it", () => {
    mockUseUniversalZap.mockReturnValue({
      quote,
      quoteUpdatedAt: 123,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    render(<ZapPageContent />);

    const calls = mockUseZapActions.mock.calls;
    const freshness = calls[calls.length - 1]?.[1];
    freshness?.onStaleQuote?.({ afterApproval: true });

    expect(refetchQuote).toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "Approval confirmed. The quote was refreshed while it was pending — check the new amounts, then zap.",
    );
  });

  it("warns instead of showing green when the quote is far above market", () => {
    mockUseUniversalZap.mockReturnValue({
      quote: { ...quote, priceImpact: -25.69 },
      quoteUpdatedAt: Date.now(),
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    render(<ZapPageContent />);
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });

    const impact = screen.getByText("-25.69%");
    expect(impact.className).toContain("text-[var(--warning)]");
    expect(impact.className).not.toContain("text-green-500");
    expect(screen.getByRole("status").textContent).toContain("25.7% above market");
  });

  it("passes autoRefresh to the quote hook (on while active)", () => {
    render(<ZapPageContent />);
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(expect.objectContaining({ autoRefresh: true }));
  });

  it("pauses the quote while the wallet prompt is open", async () => {
    const { rerender } = render(<ZapPageContent />);
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(expect.objectContaining({ paused: false }));

    const idleZap = mockUseZapActions.mock.results.at(-1)?.value as ReturnType<typeof useZapActions>;
    mockUseZapActions.mockReturnValue({
      ...idleZap,
      status: "zapping",
      isLoading: true,
    });
    rerender(<ZapPageContent />);

    await waitFor(() => {
      expect(mockUseUniversalZap).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }));
    });
  });

  it("shows the pending tx card while preparing and awaiting on-chain confirmation", () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    const preparingZap = {
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "zapping",
      error: null,
      isLoading: true,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: null,
      batchesApproval: false,
      isSimulationForCurrentQuote: () => true,
      simulationResult: null,
    } as ReturnType<typeof useZapActions>;
    mockUseZapActions.mockReturnValue(preparingZap);

    const { container, rerender } = render(<ZapPageContent />);

    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Preparing Transaction")).toBeTruthy();
    expect(screen.getByText("Confirm in your wallet. Keep this page open while the transaction submits.")).toBeTruthy();
    expect(screen.queryByText("View on Etherscan")).toBeNull();

    mockUseZapActions.mockReturnValue({
      ...preparingZap,
      status: "waitingTx",
      zapHash: "0x1234",
    } as ReturnType<typeof useZapActions>);

    rerender(<ZapPageContent />);

    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Awaiting Confirmation")).toBeTruthy();
    expect(screen.getByText("View on Etherscan")).toBeTruthy();
  });

  it.each([
    ["deposit", "Deposit confirming on-chain.", "Awaiting Confirmation"],
    ["withdraw", "Withdraw confirming on-chain.", "Awaiting Confirmation"],
  ] as const)("labels the pending card as a %s for a direct vault pair", (action, expectedCopy, expectedTitle) => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "1");
    mockUseUniversalZap.mockReturnValue({
      quote: {
        ...quote,
        inputAmount: "1",
        directVault: {
          vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
          action,
          symbol: "yscvxCRV",
        },
      },
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "waitingTx",
      error: null,
      isLoading: false,
      isSuccess: false,
      isReverted: false,
      zapHash: "0x1234",
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: null,
      batchesApproval: false,
      isSimulationForCurrentQuote: () => true,
      simulationResult: null,
    } as ReturnType<typeof useZapActions>);

    render(<ZapPageContent />);

    expect(screen.getByText(expectedTitle)).toBeTruthy();
    expect(screen.getByText(expectedCopy)).toBeTruthy();
  });

  it("keeps the deposit label on the success card after the amount resets", async () => {
    const depositQuote = {
      ...quote,
      directVault: { vaultAddress: VAULT_ADDRESSES.YSCVXCRV, action: "deposit", symbol: "yscvxCRV" },
    } as ZapQuote;
    mockUseUniversalZap.mockReturnValue({
      quote: depositQuote,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    const { rerender } = render(<ZapPageContent />);
    const idleZap = mockUseZapActions.mock.results[0].value as ReturnType<typeof useZapActions>;
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));
    await waitFor(() => expect(executeZap).toHaveBeenCalled());

    mockUseZapActions.mockReturnValue({
      ...idleZap,
      status: "success",
      isSuccess: true,
      zapHash: "0xabc",
    });
    rerender(<ZapPageContent />);

    await waitFor(() => expect(screen.getByText("Deposit Successful")).toBeTruthy());
    expect(screen.queryByText("Zap Successful")).toBeNull();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Deposit successful!", expect.anything());
  });

  it("keeps the route panel mounted with an error when the quote fails", () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseUniversalZap.mockReturnValue({
      quote: undefined,
      isLoading: false,
      error: new Error("Enso unavailable"),
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);

    const { container } = render(<ZapPageContent />);

    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("false");
    const routeDisplays = screen.getAllByTestId("route-display");
    expect(routeDisplays.every((el) => el.getAttribute("data-error") === "Failed to get quote")).toBe(true);
  });

  it.each([
    ["ysCVX → yspxCVX is temporarily unavailable. Withdraw to CVX and zap that into yspxCVX instead.", "ysCVX → yspxCVX is temporarily unavailable. Withdraw to CVX and zap that into yspxCVX instead."],
    ["No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token.", "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token."],
    ["Enso intent did not quote the requested final output token", "Route failed safety checks - try a different amount or token"],
    ["Rate limit exceeded", "Too many requests - please wait a moment"],
  ])("shows a specific route error for %s", (message, expected) => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseUniversalZap.mockReturnValue({
      quote: undefined,
      isLoading: false,
      error: new Error(message),
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);

    render(<ZapPageContent />);

    expect(screen.getAllByTestId("route-display").map((el) => el.getAttribute("data-error"))).toContain(expected);
  });

  it("keeps route details visible when the input balance is insufficient", () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseBalance.mockReturnValue({
      data: { value: 0n },
      refetch: refetchBalance,
    } as unknown as ReturnType<typeof useBalance>);

    const { container } = render(<ZapPageContent />);

    expect(screen.getByRole("button", { name: "Insufficient balance" })).toBeTruthy();
    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getAllByTestId("route-display").length).toBeGreaterThan(0);
  });

  it("never simulates or sends a quote for the previous debounced amount", async () => {
    const staleQuote = {
      ...quote,
      inputAmount: "297.900852",
    } satisfies ZapQuote;
    mockUseUniversalZap.mockReturnValue({
      quote: staleQuote,
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    mockUseDebouncedValue.mockReturnValue("297.900852");

    render(<ZapPageContent />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "200" } });

    expect(mockUseZapActions).toHaveBeenLastCalledWith(null, expect.any(Object));
    const settlingButton = screen.getByRole("button", { name: /Getting quote/ });
    expect((settlingButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(settlingButton);
    expect(executeZap).not.toHaveBeenCalled();
  });

  it("uses the quoted output amount as the input when reversing tokens", () => {
    render(<ZapPageContent />);

    const amountInput = screen.getByPlaceholderText("0.00");
    fireEvent.change(amountInput, { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Swap input and output" }));

    expect((amountInput as HTMLInputElement).value).toBe("5.0554");
    expect(sessionStorage.getItem("yldfi-universal-zap-v2-amount")).toBe("5.0554");
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({ symbol: "yscvxCRV" }),
        outputToken: expect.objectContaining({ symbol: "ETH" }),
        inputAmount: "5.0554",
      }),
    );
  });

  it("normalizes persisted known token metadata before quoting", () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-input", JSON.stringify({
      address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
      chainId: 1,
      name: "Curve.Fi USD Stablecoin",
      symbol: "crvUSD",
      decimals: 18,
      logoURI: "https://assets.coingecko.com/coins/images/30118/thumb/crvusd.jpeg",
      type: "base",
    }));

    render(<ZapPageContent />);

    expect(mockUseUniversalZap).toHaveBeenCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({
          symbol: "crvUSD",
          logoURI: "/tokens/crvusd.png",
        }),
      }),
    );
    expect(mockUseTokenBalances).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          symbol: "crvUSD",
          logoURI: "/tokens/crvusd.png",
        }),
        expect.objectContaining({ symbol: "yscvxCRV" }),
      ],
      { preferOnchain: true, fetchPrices: false },
    );
  });

  it("restores a token picked from the ordinary list together with its amount", () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-input", JSON.stringify({
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      chainId: 1,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      logoURI: "https://example.invalid/usdc.png",
      type: "base",
    }));
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "12.5");

    render(<ZapPageContent />);

    expect(screen.getByTestId("token-USDC")).toBeTruthy();
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("12.5");
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          symbol: "USDC",
          decimals: 6,
        }),
        inputAmount: "12.5",
      }),
    );
  });

  it("ignores a token stored under the old prefix", () => {
    sessionStorage.setItem("yldfi-universal-zap-input", JSON.stringify({
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      chainId: 1,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      type: "base",
    }));
    sessionStorage.setItem("yldfi-universal-zap-amount", "12.5");

    render(<ZapPageContent />);

    expect(screen.getByTestId("token-ETH")).toBeTruthy();
    expect(screen.queryByTestId("token-USDC")).toBeNull();
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("");
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({ address: ETH_ADDRESS, symbol: "ETH", decimals: 18 }),
        inputAmount: "",
      }),
    );
  });

  it.each([
    ["a bad address", { address: "not-an-address", symbol: "USDC", decimals: 6, chainId: 1 }],
    ["impossible decimals", {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 99,
      chainId: 1,
    }],
    ["a missing symbol", {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      chainId: 1,
    }],
  ])("falls back and clears the amount when a stored token has %s", (_label, stored) => {
    sessionStorage.setItem("yldfi-universal-zap-v2-input", JSON.stringify(stored));
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "12.5");

    render(<ZapPageContent />);

    expect(screen.getByTestId("token-ETH")).toBeTruthy();
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("");
    expect(sessionStorage.getItem("yldfi-universal-zap-v2-amount")).toBeNull();
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({ address: ETH_ADDRESS, symbol: "ETH" }),
        inputAmount: "",
      }),
    );
  });

  it("restores a stored token from the imported list using the imported metadata", () => {
    const importedAddress = "0x000000000000000000000000000000000000beef";
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === "yldfi-imported-tokens"
        ? JSON.stringify([{
            address: importedAddress,
            chainId: 1,
            name: "Imported Token",
            symbol: "IMPT",
            decimals: 8,
            logoURI: "/tokens/imported.png",
            type: "base",
          }])
        : null,
    );
    sessionStorage.setItem("yldfi-universal-zap-v2-input", JSON.stringify({
      address: importedAddress,
      chainId: 1,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      logoURI: "https://example.invalid/usdc.png",
      type: "base",
    }));

    render(<ZapPageContent />);

    expect(screen.getByTestId("token-IMPT")).toBeTruthy();
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({
          address: importedAddress,
          symbol: "IMPT",
          decimals: 8,
          logoURI: "/tokens/imported.png",
        }),
      }),
    );
  });

  it("ignores the link pair and warns when a requested output address is unknown", () => {
    window.history.replaceState(
      {},
      "",
      `/zap?input=${ETH_ADDRESS}&output=0x000000000000000000000000000000000000dead&outputAmount=150`,
    );
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.25");

    const { rerender } = render(<ZapPageContent />);

    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("0.25");
    expect(screen.queryByText("150")).toBeNull();
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputAmount: "0.25" }),
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(
      "This link names a token the app doesn't recognise. Pick it in the token selector.",
    );

    rerender(<ZapPageContent />);

    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("confirms the preview modal by sending with skipSimulation", async () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseSettings.mockReturnValue({
      slippage: "50",
      updateSlippage,
      showSlippageModal: false,
      setShowSlippageModal,
      showSimulationPreview: true,
      refreshSimulationPreview,
      showSimulationModal: true,
      setShowSimulationModal,
      showRoute: true,
      toggleRoute,
      setShowSimulationPreview: vi.fn(),
    });

    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "idle",
      error: null,
      isLoading: false,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: null,
      batchesApproval: false,
      isSimulationForCurrentQuote: () => true,
      simulationResult: {
        simulationId: "test-simulation",
        success: true,
        gasUsed: 123456,
        errorMessage: null,
        tenderlyUrl: null,
        assetChanges: [],
      } satisfies SimulationResult,
    } as ReturnType<typeof useZapActions>);

    render(<ZapPageContent />);

    fireEvent.click(screen.getByRole("button", { name: "Confirm Zap" }));

    await waitFor(() => {
      expect(setShowSimulationModal).toHaveBeenCalledWith(false);
      expect(executeZap).toHaveBeenCalledWith({ skipSimulation: true });
    });
  });

  function renderOpenPreview(isSimulationCurrent: boolean) {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseSettings.mockReturnValue({
      slippage: "50",
      updateSlippage,
      showSlippageModal: false,
      setShowSlippageModal,
      showSimulationPreview: true,
      refreshSimulationPreview,
      showSimulationModal: true,
      setShowSimulationModal,
      showRoute: true,
      toggleRoute,
      setShowSimulationPreview: vi.fn(),
    });

    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "idle",
      error: null,
      isLoading: false,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: null,
      batchesApproval: false,
      isSimulationForCurrentQuote: () => isSimulationCurrent,
      simulationResult: {
        simulationId: "test-simulation",
        success: true,
        gasUsed: 123456,
        errorMessage: null,
        tenderlyUrl: null,
        assetChanges: [],
      } satisfies SimulationResult,
    } as ReturnType<typeof useZapActions>);

    render(<ZapPageContent />);
  }

  it("re-previews through the page instead of sending when the quote changed under the preview", async () => {
    renderOpenPreview(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm Zap" }));

    await waitFor(() => expect(executeZap).toHaveBeenCalledWith({ previewOnly: true }));
    expect(executeZap).not.toHaveBeenCalledWith({ skipSimulation: true });
    expect(setShowSimulationModal).toHaveBeenCalledWith(false);
    expect(toast.info).toHaveBeenCalledWith(
      "The quote changed since the preview. Check the new preview, then confirm.",
    );
  });

  it("sends exactly once when the preview is still for the current quote", async () => {
    renderOpenPreview(true);

    fireEvent.click(screen.getByRole("button", { name: "Confirm Zap" }));

    await waitFor(() => expect(executeZap).toHaveBeenCalledWith({ skipSimulation: true }));
    expect(executeZap).toHaveBeenCalledTimes(1);
  });

  it("holds the re-preview of a changed high-impact quote until CONFIRM is typed", async () => {
    mockUseUniversalZap.mockReturnValue({
      quote: { ...quote, priceImpact: 99.99 },
      isLoading: false,
      error: null,
      refetch: refetchQuote,
    } as unknown as ReturnType<typeof useUniversalZap>);
    renderOpenPreview(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm Zap" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("99.99%")).toBeTruthy();
    // Nothing may run before the impact confirmation is accepted.
    expect(executeZap).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Type CONFIRM to proceed"), { target: { value: "CONFIRM" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Zap" }));

    await waitFor(() => expect(executeZap).toHaveBeenCalledWith({ previewOnly: true }));
    expect(executeZap).not.toHaveBeenCalledWith({ skipSimulation: true });
  });

  describe("high price impact confirmation", () => {
    const highImpactQuote = { ...quote, priceImpact: 99.99 };

    function renderWithQuote(zapQuote: ZapQuote) {
      mockUseUniversalZap.mockReturnValue({
        quote: zapQuote,
        isLoading: false,
        error: null,
        refetch: refetchQuote,
      } as unknown as ReturnType<typeof useUniversalZap>);
      render(<ZapPageContent />);
      fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    }

    it("holds a >=5% impact zap until CONFIRM is typed", async () => {
      renderWithQuote(highImpactQuote);
      fireEvent.click(screen.getByRole("button", { name: "Zap" }));

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("99.99%")).toBeTruthy();
      expect(executeZap).not.toHaveBeenCalled();
      // Quote refresh is paused so the impact can't change under the modal.
      expect(mockUseUniversalZap).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }));

      const confirm = within(dialog).getByRole("button", { name: "Zap" }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText("Type CONFIRM to proceed"), { target: { value: "confirm" } });
      expect(confirm.disabled).toBe(false);
      fireEvent.click(confirm);

      await waitFor(() => expect(executeZap).toHaveBeenCalledWith());
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("cancelling the confirmation never sends the zap", () => {
      renderWithQuote(highImpactQuote);
      fireEvent.click(screen.getByRole("button", { name: "Zap" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(executeZap).not.toHaveBeenCalled();
    });

    it("gates approving too, since an approval auto-executes the zap once it mines", () => {
      mockUseZapActions.mockReturnValue({
        needsApproval: () => true,
        approve,
        executeZap,
        reset,
        status: "needsApproval",
        error: null,
        isLoading: false,
        isSuccess: false,
        isReverted: false,
        zapHash: undefined,
        pendingApproval: { token: ETH_ADDRESS, spender: "0x2222222222222222222222222222222222222222", amount: 10n ** 17n },
        approvalProgress: null,
        isApproving: false,
        refetchAllowance,
        isFlashbotsEnabled: false,
        isFlashbotsSupported: false,
        toggleFlashbots,
        safePending: null,
      batchesApproval: false,
        isSimulationForCurrentQuote: () => true,
        simulationResult: null,
      } as unknown as ReturnType<typeof useZapActions>);
      renderWithQuote(highImpactQuote);

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(approve).not.toHaveBeenCalled();

      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Type CONFIRM to proceed"), { target: { value: "CONFIRM" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve & zap" }));
      expect(approve).toHaveBeenCalledWith(true);
    });

    it("sends a sub-5% impact zap without the confirmation", async () => {
      renderWithQuote({ ...quote, priceImpact: 4.99 });
      fireEvent.click(screen.getByRole("button", { name: "Zap" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(executeZap).toHaveBeenCalledWith());
    });
  });

  it("says the pending card is waiting for the Safe and its signatures", () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "zapping",
      error: null,
      isLoading: true,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: {
        isAwaitingExecution: true,
        confirmations: 2,
        confirmationsRequired: 3,
        executedHash: null,
        outcome: null,
      },
      batchesApproval: false,
      isSimulationForCurrentQuote: () => true,
      simulationResult: null,
    } as ReturnType<typeof useZapActions>);

    render(<ZapPageContent />);

    expect(screen.getByText("Waiting for Safe")).toBeTruthy();
    expect(
      screen.getByText("2 of 3 signatures collected. Sign and execute it in your Safe. This page updates once it's on-chain."),
    ).toBeTruthy();
  });

  it("reads the ETH/USD price when the simulation preview opens", async () => {
    sessionStorage.setItem("yldfi-universal-zap-v2-amount", "0.1");
    mockUseSettings.mockImplementation(() => {
      const [showSimulationModal, setShowSimulationModal] = useState(false);
      return {
        slippage: "50",
        updateSlippage,
        showSlippageModal: false,
        setShowSlippageModal,
        showSimulationPreview: true,
        refreshSimulationPreview,
        showSimulationModal,
        setShowSimulationModal,
        showRoute: true,
        toggleRoute,
        setShowSimulationPreview: vi.fn(),
      };
    });
    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve,
      executeZap,
      reset,
      status: "idle",
      error: null,
      isLoading: false,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval: null,
      approvalProgress: null,
      isApproving: false,
      refetchAllowance,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots,
      safePending: null,
      batchesApproval: false,
      isSimulationForCurrentQuote: () => true,
      simulationResult: {
        simulationId: "test-simulation",
        success: true,
        gasUsed: 123456,
        errorMessage: null,
        tenderlyUrl: null,
        assetChanges: [],
      } satisfies SimulationResult,
    } as ReturnType<typeof useZapActions>);

    render(<ZapPageContent />);

    await waitFor(() => {
      expect(screen.getByTestId("simulation-modal").getAttribute("data-eth-price")).toBe("1");
    });
  });
});
