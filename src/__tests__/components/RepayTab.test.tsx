import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useBlockNumber, useGasPrice, usePublicClient } from "wagmi";

import { RepayTab } from "@/components/lending/RepayTab";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import { CURVE_CONTROLLERS, TOKENS, VAULT_ADDRESSES, VAULTS } from "@/config/vaults";
import { useCurveLendingActions } from "@/hooks/useCurveLendingActions";
import type { LendingPosition } from "@/hooks/useCurveLendingPosition";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useSettings } from "@/hooks/useSettings";
import { useTokenBalances } from "@/hooks/useTokenBalances";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  usePublicClient: vi.fn(),
  useGasPrice: vi.fn(),
  useBlockNumber: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

vi.mock("@/hooks/useCurveLendingActions", () => ({
  useCurveLendingActions: vi.fn(),
}));

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: vi.fn(),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: vi.fn(),
}));

vi.mock("@/hooks/useTokenBalances", () => ({
  useTokenBalances: vi.fn(),
}));

vi.mock("@/components/TokenSelector", () => ({
  TokenSelector: ({
    selectedToken,
    onSelect,
  }: {
    selectedToken: { symbol: string };
    onSelect?: (token: { address: string; chainId: number; name: string; symbol: string; decimals: number; logoURI: string; type: "base" }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSelect?.({
        address: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7",
        chainId: 1,
        name: "Convex CRV",
        symbol: "cvxCRV",
        decimals: 18,
        logoURI: "",
        type: "base",
      })}
    >
      {selectedToken.symbol}
    </button>
  ),
}));

vi.mock("@/components/MaxButton", () => ({
  MaxButton: ({
    onSelect,
    balance,
    showClose,
    onClose,
  }: {
    onSelect: (amount: string) => void;
    balance: string;
    showClose?: boolean;
    onClose?: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelect(balance)}>MAX</button>
      {showClose && <button type="button" onClick={onClose}>CLOSE</button>}
    </div>
  ),
  MaxButtonSkeleton: () => <button type="button" disabled>MAX</button>,
}));

vi.mock("@/components/ApprovalCard", () => ({
  ApprovalCard: () => null,
}));

vi.mock("@/components/LoadingDots", () => ({
  LoadingDots: () => <span>...</span>,
}));

vi.mock("@/components/RouteDisplay", () => ({
  RouteDisplay: () => <div data-testid="route-display" />,
}));

vi.mock("@/components/SlippageModal", () => ({
  SlippageModal: () => null,
}));

vi.mock("@/components/SimulationModal", () => ({
  SimulationModal: () => null,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
}));

const mockUseAccount = vi.mocked(useAccount);
const mockUsePublicClient = vi.mocked(usePublicClient);
const mockUseGasPrice = vi.mocked(useGasPrice);
const mockUseBlockNumber = vi.mocked(useBlockNumber);
const mockUseQuery = vi.mocked(useQuery);
const mockUseCurveLendingActions = vi.mocked(useCurveLendingActions);
const mockUseDebouncedValue = vi.mocked(useDebouncedValue);
const mockUseSettings = vi.mocked(useSettings);
const mockUseTokenBalances = vi.mocked(useTokenBalances);

const vault = VAULTS.ycvxcrv;
const controllerAddress = CURVE_CONTROLLERS[VAULT_ADDRESSES.YCVXCRV];
const WAD = 10n ** 18n;
let settingsSlippage = "50";

function makePosition(debt: bigint, hasLoan = true): LendingPosition {
  return {
    collateral: 78_337n * 10n ** 18n,
    stablecoin: 0n,
    debt,
    N: 15,
    health: 12,
    healthFull: 12,
    liquidationPriceUpper: 0n,
    liquidationPriceLower: 0n,
    maxWithdrawable: 0n,
    hasLoan,
    inSoftLiquidation: false,
  };
}

function renderRepayTab(position: LendingPosition | null) {
  return render(
    <RepayTab
      vault={vault}
      position={position}
      controllerAddress={controllerAddress}
      onTransactionSuccess={vi.fn()}
    />,
  );
}

describe("RepayTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    settingsSlippage = "50";

    mockUseAccount.mockReturnValue({
      address: "0x1234567890123456789012345678901234567890",
    } as unknown as ReturnType<typeof useAccount>);

    mockUsePublicClient.mockReturnValue({
      readContract: vi.fn(),
    } as unknown as ReturnType<typeof usePublicClient>);

    mockUseGasPrice.mockReturnValue({ data: 1n } as ReturnType<typeof useGasPrice>);
    mockUseBlockNumber.mockReturnValue({ data: 100n } as ReturnType<typeof useBlockNumber>);
    mockUseDebouncedValue.mockImplementation((value) => value);

    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuery>);

    mockUseSettings.mockImplementation(() => ({
      slippage: settingsSlippage,
      updateSlippage: vi.fn(),
      showSlippageModal: false,
      setShowSlippageModal: vi.fn(),
      showSimulationPreview: false,
      refreshSimulationPreview: vi.fn(),
      showSimulationModal: false,
      setShowSimulationModal: vi.fn(),
      showRoute: true,
      toggleRoute: vi.fn(),
      zappersEnabled: false,
      setZappersEnabled: vi.fn(),
      setShowSimulationPreview: vi.fn(),
    }));

    mockUseCurveLendingActions.mockReturnValue({
      repayDirect: vi.fn(),
      repayAndWithdraw: vi.fn(),
      repayWithSwap: vi.fn(),
      pendingApproval: null,
      approvalProgress: null,
      approve: vi.fn(),
      isApproving: false,
      isApprovalSuccess: false,
      executeAfterApproval: vi.fn(),
      wasApprovalRequested: vi.fn(() => false),
      status: "idle",
      txHash: undefined,
      error: null,
      simulationResult: null,
      reset: vi.fn(),
      clearError: vi.fn(),
      executeAfterPreview: vi.fn(),
    } as unknown as ReturnType<typeof useCurveLendingActions>);

    mockUseTokenBalances.mockReturnValue({
      sortedTokens: [],
      balanceMap: new Map([
        [CRVUSD_ADDRESS.toLowerCase(), 10_000n * 10n ** 18n],
        [TOKENS.CVXCRV.toLowerCase(), 10_000n * 10n ** 18n],
      ]),
      priceMap: new Map(),
      refetch: vi.fn(),
      refetchOnchain: vi.fn(),
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);
  });

  it("keeps the entered repay amount when debt accrues between position refreshes", () => {
    const { rerender } = renderRepayTab(makePosition(7_104n * 10n ** 18n));

    const input = screen.getByPlaceholderText("0.0");
    fireEvent.change(input, { target: { value: "120.198832" } });

    expect((input as HTMLInputElement).value).toBe("120.198832");

    rerender(
      <RepayTab
        vault={vault}
        position={makePosition(7_104n * 10n ** 18n + 123_456n)}
        controllerAddress={controllerAddress}
        onTransactionSuccess={vi.fn()}
      />,
    );

    expect((screen.getByPlaceholderText("0.0") as HTMLInputElement).value).toBe("120.198832");
  });

  it("clears the entered repay amount when the active loan disappears", async () => {
    const { rerender } = renderRepayTab(makePosition(7_104n * 10n ** 18n));

    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "120.198832" },
    });

    rerender(
      <RepayTab
        vault={vault}
        position={makePosition(0n, false)}
        controllerAddress={controllerAddress}
        onTransactionSuccess={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No active loan to repay")).toBeTruthy();
    });

    rerender(
      <RepayTab
        vault={vault}
        position={makePosition(7_104n * 10n ** 18n)}
        controllerAddress={controllerAddress}
        onTransactionSuccess={vi.fn()}
      />,
    );

    expect((screen.getByPlaceholderText("0.0") as HTMLInputElement).value).toBe("");
  });

  it("blocks partial repay below Curve's minimum valid repay amount", () => {
    mockUseQuery.mockImplementation((options) => {
      const queryKey = (options as { queryKey?: unknown[] }).queryKey;
      if (queryKey?.[0] === "minimum-partial-repay") {
        return {
          data: 1_300n * 10n ** 18n,
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: vi.fn(),
        } as unknown as ReturnType<typeof useQuery>;
      }
      return {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>;
    });

    renderRepayTab(makePosition(7_104n * 10n ** 18n));

    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "100" },
    });

    expect(screen.getByText(/Curve requires at least 1,300 crvUSD/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Repay at least 1,300 crvUSD/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the active slippage when sizing a swap-token close", async () => {
    settingsSlippage = "300";
    mockUseQuery.mockImplementation((options) => {
      const queryKey = (options as { queryKey?: unknown[] }).queryKey;
      if (queryKey?.[0] === "repay-max-token" && queryKey[1] === TOKENS.CVXCRV) {
        return {
          data: "100",
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: vi.fn(),
        } as unknown as ReturnType<typeof useQuery>;
      }
      if (queryKey?.[0] === "repay-swap-quote") {
        return {
          data: { amountOut: (1_001n * WAD).toString() },
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: vi.fn(),
        } as unknown as ReturnType<typeof useQuery>;
      }
      return {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>;
    });

    renderRepayTab(makePosition(1_000n * WAD));

    fireEvent.click(screen.getByRole("button", { name: "crvUSD" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "cvxCRV" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "CLOSE" }));

    expect((screen.getByPlaceholderText("0.0") as HTMLInputElement).value).toBe("104.00000000");
  });

  it("blocks swap-token close when the live quote cannot cover the full debt", async () => {
    settingsSlippage = "300";
    mockUseQuery.mockImplementation((options) => {
      const queryKey = (options as { queryKey?: unknown[] }).queryKey;
      if (queryKey?.[0] === "repay-max-token" && queryKey[1] === TOKENS.CVXCRV) {
        return {
          data: "100",
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: vi.fn(),
        } as unknown as ReturnType<typeof useQuery>;
      }
      if (queryKey?.[0] === "repay-swap-quote") {
        return {
          data: { amountOut: (990n * WAD).toString() },
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: vi.fn(),
        } as unknown as ReturnType<typeof useQuery>;
      }
      return {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useQuery>;
    });

    renderRepayTab(makePosition(1_000n * WAD));

    fireEvent.click(screen.getByRole("button", { name: "crvUSD" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "cvxCRV" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "CLOSE" }));

    expect(screen.getByText(/expected to produce 990 crvUSD/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Increase amount to close" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
