import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatUnits, parseUnits } from "viem";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useBalance,
  useBlockNumber,
  useGasPrice,
  usePublicClient,
} from "wagmi";

import { VaultPageContent } from "@/components/VaultPageContent";
import {
  isExitOnlyVault,
  isVaultHiddenUnlessHolder,
  VAULTS,
  type VaultConfig,
} from "@/config/vaults";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";
import { useCvxPrice } from "@/hooks/useCvxPrice";
import { useCurveLendingVault } from "@/hooks/useCurveLendingData";
import { useCurveLendingPosition } from "@/hooks/useCurveLendingPosition";
import { useCurveMarketRates } from "@/hooks/useCurveMarketRates";
import { useMerklOpportunities, useMerklRewards } from "@/hooks/useMerklRewards";
import { usePricePerShare } from "@/hooks/usePricePerShare";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useVaultActions } from "@/hooks/useVaultActions";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useVaultCache } from "@/hooks/useVaultCache";
import { useVaultData } from "@/hooks/useVaultData";
import { useYearnVault } from "@/hooks/useYearnVault";
import { useZapActions } from "@/hooks/useZapActions";
import { useZapQuote } from "@/hooks/useZapQuote";
import { notFound } from "next/navigation";
import { toast } from "sonner";

const settingsState = vi.hoisted(() => ({ showSimulationPreview: false }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("next/image", () => ({
  default: () => <div data-testid="next-image" />,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/analytics", () => ({
  trackVaultView: vi.fn(),
  trackDepositInitiated: vi.fn(),
  trackDepositSuccess: vi.fn(),
  trackWithdrawInitiated: vi.fn(),
  trackWithdrawSuccess: vi.fn(),
  trackApprovalInitiated: vi.fn(),
  trackApprovalSuccess: vi.fn(),
  trackTransactionError: vi.fn(),
  trackTransactionCancelled: vi.fn(),
  trackZapInitiated: vi.fn(),
  trackZapSuccess: vi.fn(),
  isUserRejection: vi.fn(() => false),
}));

vi.mock("@/components/Header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@/components/Footer", () => ({
  Footer: () => <div data-testid="footer" />,
}));

vi.mock("@/components/VaultInfoCard", () => ({
  VaultInfoCard: () => <div data-testid="vault-info-card" />,
}));

vi.mock("@/components/ContractExplorer", () => ({
  ContractExplorer: () => <div data-testid="contract-explorer" />,
  useContractExplorer: () => ({
    isOpen: false,
    address: "",
    title: undefined,
    lastUpdated: undefined,
    icon: undefined,
    showFlowTab: false,
    activeTab: "flow",
    openExplorer: vi.fn(),
    switchContract: vi.fn(),
    closeExplorer: vi.fn(),
    setActiveTab: vi.fn(),
  }),
}));

vi.mock("@/components/RouteDisplay", () => ({
  RouteDisplay: () => <div data-testid="route-display" />,
}));

vi.mock("@/components/TokenSelector", () => ({
  TokenSelector: () => <div data-testid="token-selector" />,
}));

vi.mock("@/components/SlippageModal", () => ({
  SlippageModal: () => null,
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
  }) =>
    isOpen ? (
      <div data-testid="simulation-modal">
        <button type="button" onClick={onConfirm}>{confirmText ?? "Confirm"}</button>
        <button type="button" onClick={onClose}>Close simulation</button>
      </div>
    ) : null,
}));

vi.mock("@/hooks/useSettings", async () => {
  const { useState } = await import("react");
  return {
    useSettings: () => {
      const [showSlippageModal, setShowSlippageModal] = useState(false);
      const [showSimulationModal, setShowSimulationModal] = useState(false);
      return {
        slippage: "50",
        updateSlippage: vi.fn(),
        showSlippageModal,
        setShowSlippageModal,
        showSimulationPreview: settingsState.showSimulationPreview,
        setShowSimulationPreview: vi.fn(),
        refreshSimulationPreview: vi.fn(),
        showSimulationModal,
        setShowSimulationModal,
        showRoute: true,
        toggleRoute: vi.fn(),
      };
    },
  };
});

vi.mock("@/hooks/useVaultData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useVaultData")>();
  return { ...actual, useVaultData: vi.fn() };
});

vi.mock("@/hooks/useYearnVault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useYearnVault")>();
  return { ...actual, useYearnVault: vi.fn() };
});

vi.mock("@/hooks/useCurveLendingData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useCurveLendingData")>();
  return { ...actual, useCurveLendingVault: vi.fn() };
});

vi.mock("@/hooks/useCurveLendingPosition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useCurveLendingPosition")>();
  return { ...actual, useCurveLendingPosition: vi.fn() };
});

vi.mock("@/hooks/useMerklRewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useMerklRewards")>();
  return {
    ...actual,
    useMerklRewards: vi.fn(),
    useMerklOpportunities: vi.fn(),
  };
});

vi.mock("@/hooks/useCurveMarketRates", () => ({
  useCurveMarketRates: vi.fn(),
}));

vi.mock("@/hooks/useCvxCrvPrice", () => ({
  useCvxCrvPrice: vi.fn(),
}));

vi.mock("@/hooks/useCvxPrice", () => ({
  useCvxPrice: vi.fn(),
}));

vi.mock("@/hooks/usePricePerShare", () => ({
  usePricePerShare: vi.fn(),
}));

vi.mock("@/hooks/useVaultCache", () => ({
  useVaultCache: vi.fn(),
}));

vi.mock("@/hooks/useTokenBalance", () => ({
  useTokenBalance: vi.fn(),
}));

vi.mock("@/hooks/useVaultBalance", () => ({
  useVaultBalance: vi.fn(),
}));

vi.mock("@/hooks/useVaultActions", () => ({
  useVaultActions: vi.fn(),
}));

vi.mock("@/hooks/useZapQuote", () => ({
  useZapQuote: vi.fn(),
}));

vi.mock("@/hooks/useZapActions", () => ({
  useZapActions: vi.fn(),
}));

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: unknown) => value,
}));

vi.mock("@/hooks/useIdle", () => ({
  useIdle: () => false,
}));

vi.mock("@/hooks/useClearOnNavigation", () => ({
  useClearOnNavigation: () => {},
}));

vi.mock("@/hooks/useAutoContinueAfterApproval", () => ({
  useAutoContinueAfterApproval: () => {},
}));

const mockUseAccount = vi.mocked(useAccount);
const mockUseBalance = vi.mocked(useBalance);
const mockUseBlockNumber = vi.mocked(useBlockNumber);
const mockUseGasPrice = vi.mocked(useGasPrice);
const mockUsePublicClient = vi.mocked(usePublicClient);
const mockUseConnectModal = vi.mocked(useConnectModal);
const mockUseTokenBalance = vi.mocked(useTokenBalance);
const mockUseVaultBalance = vi.mocked(useVaultBalance);
const mockUseVaultActions = vi.mocked(useVaultActions);
const mockUsePricePerShare = vi.mocked(usePricePerShare);
const mockUseVaultCache = vi.mocked(useVaultCache);
const mockUseVaultData = vi.mocked(useVaultData);
const mockUseYearnVault = vi.mocked(useYearnVault);
const mockUseCurveLendingVault = vi.mocked(useCurveLendingVault);
const mockUseCurveLendingPosition = vi.mocked(useCurveLendingPosition);
const mockUseCurveMarketRates = vi.mocked(useCurveMarketRates);
const mockUseMerklRewards = vi.mocked(useMerklRewards);
const mockUseMerklOpportunities = vi.mocked(useMerklOpportunities);
const mockUseCvxCrvPrice = vi.mocked(useCvxCrvPrice);
const mockUseCvxPrice = vi.mocked(useCvxPrice);
const mockUseZapQuote = vi.mocked(useZapQuote);
const mockUseZapActions = vi.mocked(useZapActions);
const mockNotFound = vi.mocked(notFound);

const vaultUnderTest = Object.values(VAULTS).find(
  (vault) => !vault.hidden && !vault.deprecated && !isVaultHiddenUnlessHolder(vault),
) as VaultConfig;
const exitOnlyVault = Object.values(VAULTS).find((vault) => isExitOnlyVault(vault)) as VaultConfig;

const TOKEN_DECIMALS = 18;
const DEFAULT_TOKEN_BALANCE = 100n * 10n ** 18n;
const DEFAULT_SHARE_BALANCE = 50n * 10n ** 18n;

type VaultActionsResult = ReturnType<typeof useVaultActions>;

const deposit = vi.fn<
  (amount: string, options?: { previewOnly?: boolean; batchApproval?: bigint }) => Promise<unknown>
>();
const approve = vi.fn<(exactAmount?: bigint) => Promise<void>>();
const withdraw = vi.fn<(amount: string, options?: { previewOnly?: boolean }) => Promise<unknown>>();
const executeAfterPreview = vi.fn<
  (expected?: { type: "deposit" | "withdraw"; amount: string }) => Promise<boolean>
>();
const isPreviewFor = vi.fn<(type: "deposit" | "withdraw", amount: string) => boolean>();
const needsApproval = vi.fn<(amount: string) => boolean>();
const resetVaultActions = vi.fn<() => void>();

type SetupOptions = {
  vault?: VaultConfig;
  connected?: boolean;
  needsApproval?: boolean;
  batchesApproval?: boolean;
  isLoading?: boolean;
  status?: VaultActionsResult["status"];
  simulationResult?: VaultActionsResult["simulationResult"];
  isPreviewFor?: boolean;
  depositResult?: unknown;
  withdrawResult?: unknown;
  tokenBalance?: bigint;
  vaultBalance?: bigint;
};

function defaultVaultActions(): VaultActionsResult {
  return {
    needsApproval,
    approve,
    deposit,
    withdraw,
    executeAfterPreview,
    isPreviewFor,
    reset: resetVaultActions,
    status: "idle",
    error: null,
    isLoading: false,
    isSuccess: false,
    isReverted: false,
    depositHash: undefined,
    withdrawHash: undefined,
    simulationResult: null,
    safePending: null,
    batchesApproval: false,
  } as unknown as VaultActionsResult;
}

function installDefaultHooks(options: SetupOptions = {}) {
  const tokenBalance = options.tokenBalance ?? DEFAULT_TOKEN_BALANCE;
  const vaultBalance = options.vaultBalance ?? DEFAULT_SHARE_BALANCE;

  deposit.mockReset();
  deposit.mockResolvedValue(options.depositResult ?? null);
  approve.mockReset();
  approve.mockResolvedValue(undefined);
  withdraw.mockReset();
  withdraw.mockResolvedValue(options.withdrawResult ?? null);
  executeAfterPreview.mockReset();
  executeAfterPreview.mockResolvedValue(true);
  isPreviewFor.mockReset();
  isPreviewFor.mockReturnValue(options.isPreviewFor ?? true);
  needsApproval.mockReset();
  needsApproval.mockReturnValue(options.needsApproval ?? false);
  resetVaultActions.mockReset();

  mockUseAccount.mockReturnValue({
    address: options.connected === false ? undefined : "0x1234567890123456789012345678901234567890",
    isConnected: options.connected !== false,
  } as unknown as ReturnType<typeof useAccount>);

  mockUseBalance.mockReturnValue({
    data: { value: 10n ** 18n, formatted: "1", decimals: 18 },
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useBalance>);

  mockUseBlockNumber.mockReturnValue({ data: 1n } as ReturnType<typeof useBlockNumber>);
  mockUseGasPrice.mockReturnValue({ data: 1n } as ReturnType<typeof useGasPrice>);
  mockUsePublicClient.mockReturnValue({
    readContract: vi.fn(async () => [0n, 100_000_000n]),
  } as unknown as ReturnType<typeof usePublicClient>);

  mockUseConnectModal.mockReturnValue({
    connectModalOpen: false,
    openConnectModal: vi.fn(),
  } as unknown as ReturnType<typeof useConnectModal>);

  mockUseTokenBalance.mockReturnValue({
    balance: tokenBalance,
    decimals: TOKEN_DECIMALS,
    formatted: formatUnits(tokenBalance, TOKEN_DECIMALS),
    isLoading: false,
    refetch: vi.fn(),
  });

  mockUseVaultBalance.mockReturnValue({
    balance: vaultBalance,
    decimals: TOKEN_DECIMALS,
    formatted: formatUnits(vaultBalance, TOKEN_DECIMALS),
    formattedUsd: "$0",
    isLoading: false,
    refetch: vi.fn(),
  });

  mockUsePricePerShare.mockReturnValue({
    pricePerShare: 1,
    pricePerShareFormatted: "1.0000",
    decimals: TOKEN_DECIMALS,
    isLoading: false,
    error: null,
  });

  mockUseVaultCache.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useVaultCache>);
  mockUseVaultData.mockReturnValue({
    totalAssets: 0n,
    pricePerShare: 1n,
    decimals: TOKEN_DECIMALS,
    accountant: "0x0000000000000000000000000000000000000000",
    managementFee: 0,
    performanceFee: 0,
    isLoading: false,
    error: null,
  });
  mockUseYearnVault.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useYearnVault>);
  mockUseCurveLendingVault.mockReturnValue({
    vault: undefined,
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useCurveLendingVault>);
  mockUseCurveLendingPosition.mockReturnValue({
    position: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useCurveLendingPosition>);
  mockUseCurveMarketRates.mockReturnValue(null);
  mockUseMerklRewards.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useMerklRewards>);
  mockUseMerklOpportunities.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useMerklOpportunities>);
  mockUseCvxCrvPrice.mockReturnValue({ price: 0 } as unknown as ReturnType<typeof useCvxCrvPrice>);
  mockUseCvxPrice.mockReturnValue({ price: 0 } as unknown as ReturnType<typeof useCvxPrice>);

  mockUseZapQuote.mockReturnValue({
    quote: null,
    quoteUpdatedAt: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useZapQuote>);
  mockUseZapActions.mockReturnValue({
    needsApproval: () => false,
    approve: vi.fn(),
    executeZap: vi.fn(async () => null),
    reset: vi.fn(),
    status: "idle",
    error: null,
    isLoading: false,
    isSuccess: false,
    isReverted: false,
    zapHash: undefined,
    pendingApproval: null,
    approvalProgress: null,
    isApproving: false,
    isFlashbotsEnabled: false,
    isFlashbotsSupported: false,
    toggleFlashbots: vi.fn(),
    simulationResult: null,
    isSimulationForCurrentQuote: () => true,
    safePending: null,
    batchesApproval: false,
  } as unknown as ReturnType<typeof useZapActions>);

  mockUseVaultActions.mockReturnValue({
    ...defaultVaultActions(),
    needsApproval,
    status: options.status ?? "idle",
    isLoading: options.isLoading ?? false,
    simulationResult: options.simulationResult ?? null,
    batchesApproval: options.batchesApproval ?? false,
  } as VaultActionsResult);
}

function setup(options: SetupOptions = {}) {
  const vault = options.vault ?? vaultUnderTest;
  installDefaultHooks(options);
  const utils = render(<VaultPageContent id={vault.id} />);
  return {
    ...utils,
    vault,
    deposit,
    approve,
    withdraw,
    executeAfterPreview,
    isPreviewFor,
    needsApproval,
  };
}

function actionButton(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function typeAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localStorage.getItem).mockReset();
  sessionStorage.clear();
  settingsState.showSimulationPreview = false;
});

describe("VaultPageContent deposit and withdraw form", () => {
  it("shows Connect Wallet when no wallet is connected", () => {
    setup({ connected: false });

    const connect = actionButton("Connect Wallet");
    fireEvent.click(connect);

    expect(mockUseConnectModal.mock.results.at(-1)?.value.openConnectModal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
  });

  it("disables the action button while the amount is empty", () => {
    setup();

    const button = actionButton("Enter amount");
    expect(button.disabled).toBe(true);
  });

  it("blocks a deposit above the token balance", () => {
    setup();

    typeAmount("101");

    const button = actionButton("Insufficient balance");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deposit).not.toHaveBeenCalled();
  });

  it("allows a deposit exactly equal to the token balance (bigint comparison)", () => {
    setup({ tokenBalance: 192124031258363920000n });

    typeAmount("192.12403125836392");

    const button = actionButton("Deposit");
    expect(button.disabled).toBe(false);
  });

  it("deposits the typed string directly when previews are off and no approval is needed", () => {
    setup();

    typeAmount("10");
    fireEvent.click(actionButton("Deposit"));

    expect(deposit.mock.calls).toEqual([["10"]]);
    expect(approve).not.toHaveBeenCalled();
  });

  it("offers exact and unlimited approval buttons when approval is needed", () => {
    setup({ needsApproval: true });

    typeAmount("10");

    expect(screen.getByRole("button", { name: "10 CVX" })).toBeTruthy();
    expect(actionButton("Unlimited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
  });

  it("approves the exact amount through the exact approval button", () => {
    setup({ needsApproval: true });

    typeAmount("10");
    fireEvent.click(screen.getByRole("button", { name: "10 CVX" }));

    expect(approve).toHaveBeenCalledWith(parseUnits("10", TOKEN_DECIMALS));
    expect(deposit).not.toHaveBeenCalled();
  });

  it("approves unlimited through the Unlimited button", () => {
    setup({ needsApproval: true });

    typeAmount("10");
    fireEvent.click(actionButton("Unlimited"));

    expect(approve).toHaveBeenCalledWith(undefined);
    expect(deposit).not.toHaveBeenCalled();
  });

  it("batches approval into the deposit on a Safe when previews are off", () => {
    setup({ needsApproval: true, batchesApproval: true });

    typeAmount("10");

    fireEvent.click(actionButton("Approve & deposit"));

    expect(deposit).toHaveBeenCalledWith("10", {
      batchApproval: parseUnits("10", TOKEN_DECIMALS),
    });
  });

  it("runs a preview-only deposit and shows the confirm modal when previews are on", async () => {
    settingsState.showSimulationPreview = true;
    setup({
      depositResult: { success: true, assetChanges: [] },
      simulationResult: { success: true, gasUsed: null, errorMessage: null, simulationId: null, tenderlyUrl: null, assetChanges: [] },
    });

    typeAmount("10");
    await act(async () => {
      fireEvent.click(actionButton("Deposit"));
    });

    expect(deposit).toHaveBeenCalledWith("10", expect.objectContaining({ previewOnly: true }));
    expect(deposit).toHaveBeenCalledTimes(1);
    expect(deposit.mock.calls.some((call) => call.length === 1)).toBe(false);
    expect(screen.getByRole("button", { name: "Confirm Deposit" })).toBeTruthy();
  });

  it("falls through to a direct deposit when the preview returns nothing", async () => {
    settingsState.showSimulationPreview = true;
    setup({ depositResult: null });

    typeAmount("10");
    await act(async () => {
      fireEvent.click(actionButton("Deposit"));
    });

    expect(deposit).toHaveBeenCalledTimes(2);
    expect(deposit.mock.calls[0]).toEqual(["10", expect.objectContaining({ previewOnly: true })]);
    expect(deposit.mock.calls[1]).toEqual(["10"]);
  });

  it("executes the stored preview from the confirm modal when the preview still matches", async () => {
    settingsState.showSimulationPreview = true;
    setup({
      depositResult: { success: true, assetChanges: [] },
      simulationResult: { success: true, gasUsed: null, errorMessage: null, simulationId: null, tenderlyUrl: null, assetChanges: [] },
      isPreviewFor: true,
    });

    typeAmount("10");
    await act(async () => {
      fireEvent.click(actionButton("Deposit"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Deposit" }));

    expect(isPreviewFor).toHaveBeenCalledWith("deposit", "10");
    expect(executeAfterPreview).toHaveBeenCalledTimes(1);
    expect(executeAfterPreview).toHaveBeenCalledWith({ type: "deposit", amount: "10" });
  });

  it("warns and re-previews instead of executing when the amount changed", async () => {
    settingsState.showSimulationPreview = true;
    setup({
      depositResult: { success: true, assetChanges: [] },
      simulationResult: { success: true, gasUsed: null, errorMessage: null, simulationId: null, tenderlyUrl: null, assetChanges: [] },
      isPreviewFor: false,
    });

    typeAmount("10");
    await act(async () => {
      fireEvent.click(actionButton("Deposit"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Deposit" }));
    });

    expect(executeAfterPreview).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("amount changed since the preview"),
    );
    expect(deposit).toHaveBeenCalledTimes(2);
    expect(deposit.mock.calls[1]).toEqual(["10", expect.objectContaining({ previewOnly: true })]);
  });

  it("checks the withdraw form against the share balance and sends the withdrawal", () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "yldfi-active-tab" ? "withdraw" : null,
    );
    setup();

    typeAmount("60");
    const insufficient = actionButton("Insufficient balance");
    expect(insufficient.disabled).toBe(true);

    typeAmount("40");
    fireEvent.click(actionButton("Withdraw"));

    expect(withdraw.mock.calls).toEqual([["40"]]);
    expect(deposit).not.toHaveBeenCalled();
  });

  it("previews a withdrawal when previews are on", async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "yldfi-active-tab" ? "withdraw" : null,
    );
    settingsState.showSimulationPreview = true;
    setup({
      withdrawResult: { success: true, assetChanges: [] },
      simulationResult: { success: true, gasUsed: null, errorMessage: null, simulationId: null, tenderlyUrl: null, assetChanges: [] },
    });

    typeAmount("40");
    await act(async () => {
      fireEvent.click(actionButton("Withdraw"));
    });

    expect(withdraw).toHaveBeenCalledWith("40", expect.objectContaining({ previewOnly: true }));
    expect(deposit).not.toHaveBeenCalled();
  });

  it("shows Approving and disables the button while an approval is in flight", () => {
    setup({ isLoading: true, status: "approving" });

    typeAmount("10");

    const button = screen.getByRole("button", { name: /^Approving/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("hides the form behind the pending card while the deposit is in flight", () => {
    setup({ isLoading: true, status: "depositing" });

    expect(screen.queryByRole("button", { name: /^Confirm in wallet/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(screen.getByText("Preparing Transaction")).toBeTruthy();
  });

  it("keeps allowed withdrawals available but disables the deposit tab on an exit-only vault", async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "yldfi-active-tab" ? "deposit" : null,
    );
    setup({ vault: exitOnlyVault });

    const depositTab = screen.getByRole("button", { name: "deposit" }) as HTMLButtonElement;
    expect(depositTab.disabled).toBe(true);

    fireEvent.click(depositTab);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "withdraw" })).toBeTruthy();
    });

    expect(deposit).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it("calls notFound for an unknown vault id", () => {
    installDefaultHooks();

    expect(() => render(<VaultPageContent id="not-a-real-vault" />)).toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});
