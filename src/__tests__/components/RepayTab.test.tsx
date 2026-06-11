import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useBlockNumber, useGasPrice, usePublicClient } from "wagmi";

import { RepayTab } from "@/components/lending/RepayTab";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import { CURVE_CONTROLLERS, VAULT_ADDRESSES, VAULTS } from "@/config/vaults";
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
  TokenSelector: ({ selectedToken }: { selectedToken: { symbol: string } }) => (
    <button type="button">{selectedToken.symbol}</button>
  ),
}));

vi.mock("@/components/MaxButton", () => ({
  MaxButton: ({ onSelect, balance }: { onSelect: (amount: string) => void; balance: string }) => (
    <button type="button" onClick={() => onSelect(balance)}>MAX</button>
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

    mockUseSettings.mockReturnValue({
      slippage: "50",
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
    });

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
      balanceMap: new Map([[CRVUSD_ADDRESS.toLowerCase(), 10_000n * 10n ** 18n]]),
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
});
