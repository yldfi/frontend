import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useBalance, useBlockNumber, useGasPrice } from "wagmi";

import { ZapPageContent } from "@/components/ZapPageContent";
import { useSettings } from "@/hooks/useSettings";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useUniversalZap } from "@/hooks/useUniversalZap";
import { useZapActions } from "@/hooks/useZapActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { ETH_ADDRESS } from "@/lib/enso";
import { TOKENS } from "@/config/vaults";
import type { SimulationResult, ZapQuote } from "@/types/enso";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useBalance: vi.fn(),
  useBlockNumber: vi.fn(),
  useGasPrice: vi.fn(),
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
  ApprovalCard: () => null,
}));

vi.mock("@/components/LoadingDots", () => ({
  LoadingDots: () => <span data-testid="loading-dots">...</span>,
}));

vi.mock("@/components/RouteDisplay", () => ({
  RouteDisplay: ({ routeInfo, isLoading }: { routeInfo?: unknown; isLoading?: boolean }) => (
    <div data-testid="route-display" data-has-route={routeInfo ? "true" : "false"} data-loading={isLoading ? "true" : "false"} />
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
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    onClose: () => void;
    confirmText?: string;
  }) => isOpen ? (
    <div data-testid="simulation-modal">
      <button type="button" onClick={onConfirm}>{confirmText ?? "Confirm"}</button>
      <button type="button" onClick={onClose}>Close simulation</button>
    </div>
  ) : null,
}));

const mockUseAccount = vi.mocked(useAccount);
const mockUseBalance = vi.mocked(useBalance);
const mockUseBlockNumber = vi.mocked(useBlockNumber);
const mockUseGasPrice = vi.mocked(useGasPrice);
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
      zappersEnabled: true,
      setZappersEnabled: vi.fn(),
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
      `/zap?input=${ETH_ADDRESS}&output=${TOKENS.CVX}&outputSymbol=CVX&outputDecimals=18&outputLogo=%2Ftokens%2Fcvx.png&outputAmount=150`,
    );

    render(<ZapPageContent />);

    expect(screen.getByTestId("token-ETH")).toBeTruthy();
    expect(screen.getByTestId("token-CVX")).toBeTruthy();
    expect(mockUseTokenBalances).toHaveBeenCalledWith(
      [
        expect.objectContaining({ symbol: "ETH" }),
        expect.objectContaining({ address: TOKENS.CVX, symbol: "CVX" }),
      ],
      { preferOnchain: true },
    );
    expect((screen.getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("1");
    expect(screen.getByText("150")).toBeTruthy();
  });

  it("does not flash provisional route details while calibrating an auction target", () => {
    window.history.replaceState(
      {},
      "",
      `/zap?input=${ETH_ADDRESS}&output=${TOKENS.CVX}&outputSymbol=CVX&outputDecimals=18&outputAmount=150`,
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
      zappersEnabled: true,
      setZappersEnabled: vi.fn(),
      setShowSimulationPreview: vi.fn(),
    });

    render(<ZapPageContent />);

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));

    await waitFor(() => {
      expect(executeZap).toHaveBeenCalledWith({ previewOnly: true });
    });
  });

  it("sends directly when simulation preview is disabled", async () => {
    render(<ZapPageContent />);

    expect(mockUseTokenBalances).toHaveBeenCalledWith(
      [
        expect.objectContaining({ symbol: "ETH" }),
        expect.objectContaining({ symbol: "yscvxCRV" }),
      ],
      { preferOnchain: true },
    );

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zap" }));

    await waitFor(() => {
      expect(executeZap).toHaveBeenCalledWith();
    });
  });

  it("keeps the route visible while the zap is preparing and hides it after submission", () => {
    sessionStorage.setItem("yldfi-universal-zap-amount", "0.1");
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
      simulationResult: null,
    } as ReturnType<typeof useZapActions>;
    mockUseZapActions.mockReturnValue(preparingZap);

    const { container, rerender } = render(<ZapPageContent />);

    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByRole("button", { name: /Confirm in wallet/ })).toBeTruthy();

    mockUseZapActions.mockReturnValue({
      ...preparingZap,
      status: "waitingTx",
      zapHash: "0x1234",
    } as ReturnType<typeof useZapActions>);

    rerender(<ZapPageContent />);

    expect(container.querySelector("aside")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("View on Etherscan")).toBeTruthy();
  });

  it("keeps route details visible when the input balance is insufficient", () => {
    sessionStorage.setItem("yldfi-universal-zap-amount", "0.1");
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

    expect(mockUseZapActions).toHaveBeenLastCalledWith(null);
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
    expect(sessionStorage.getItem("yldfi-universal-zap-amount")).toBe("5.0554");
    expect(mockUseUniversalZap).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputToken: expect.objectContaining({ symbol: "yscvxCRV" }),
        outputToken: expect.objectContaining({ symbol: "ETH" }),
        inputAmount: "5.0554",
      }),
    );
  });

  it("normalizes persisted known token metadata before quoting", () => {
    sessionStorage.setItem("yldfi-universal-zap-input", JSON.stringify({
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
      { preferOnchain: true },
    );
  });

  it("confirms the preview modal by sending with skipSimulation", async () => {
    sessionStorage.setItem("yldfi-universal-zap-amount", "0.1");
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
      zappersEnabled: true,
      setZappersEnabled: vi.fn(),
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
});
