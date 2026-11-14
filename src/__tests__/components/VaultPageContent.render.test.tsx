import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useIdle } from "@/hooks/useIdle";
import {
  useMerklOpportunities,
  useMerklRewards,
  type MerklOpportunity,
  type MerklReward,
} from "@/hooks/useMerklRewards";
import { usePricePerShare } from "@/hooks/usePricePerShare";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useVaultActions } from "@/hooks/useVaultActions";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useVaultCache } from "@/hooks/useVaultCache";
import { useVaultData } from "@/hooks/useVaultData";
import { useYearnVault } from "@/hooks/useYearnVault";
import { useZapActions } from "@/hooks/useZapActions";
import { useZapQuote } from "@/hooks/useZapQuote";
import type { PendingApproval } from "@/types/approval";
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
    ethPrice,
    simulationResult,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    onClose: () => void;
    confirmText?: string;
    ethPrice?: number | null;
    simulationResult?: { simulationUnavailable?: boolean; simulationUnavailableReason?: string };
  }) =>
    isOpen ? (
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

vi.mock("@/components/TxPendingCard", () => ({
  TxPendingCard: ({
    title,
    message,
    details,
  }: {
    title: string;
    message: string;
    details?: { fromSymbol?: string } | null;
  }) => (
    <div data-testid="tx-pending-card" data-details-symbol={details?.fromSymbol ?? ""}>
      <span>{title}</span>
      <span>{message}</span>
    </div>
  ),
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

vi.mock("@/hooks/useMerklRewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useMerklRewards")>();
  return {
    ...actual,
    useMerklRewards: vi.fn(),
    useMerklOpportunities: vi.fn(),
  };
});

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
  useDebouncedValue: vi.fn((value: unknown) => value),
}));

vi.mock("@/hooks/useIdle", () => ({
  useIdle: vi.fn(() => false),
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
const mockUseMerklRewards = vi.mocked(useMerklRewards);
const mockUseMerklOpportunities = vi.mocked(useMerklOpportunities);
const mockUseCvxCrvPrice = vi.mocked(useCvxCrvPrice);
const mockUseCvxPrice = vi.mocked(useCvxPrice);
const mockUseZapQuote = vi.mocked(useZapQuote);
const mockUseZapActions = vi.mocked(useZapActions);
const mockUseDebouncedValue = vi.mocked(useDebouncedValue);
const mockUseIdle = vi.mocked(useIdle);
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
  merklRewards?: MerklReward[];
  merklOpportunities?: MerklOpportunity[];
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
  mockUseMerklRewards.mockReturnValue({
    data: options.merklRewards ? [{ rewards: options.merklRewards }] : undefined,
  } as unknown as ReturnType<typeof useMerklRewards>);
  mockUseMerklOpportunities.mockReturnValue({
    data: options.merklOpportunities,
  } as unknown as ReturnType<typeof useMerklOpportunities>);
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

const YLD_CAMPAIGN_ID = "0xb12032fde1bfb5ba7a853ed91ddfb164764b0eb3813cbfa25799af06efe117be";

/** A yld-campaign reward in the shape the real campaign split helpers expect. */
function yldReward(
  overrides: {
    amount?: string;
    claimed?: string;
    pending?: string;
    token?: Partial<MerklReward["token"]>;
  } = {},
): MerklReward {
  const amount = overrides.amount ?? "2000000000000000000";
  const claimed = overrides.claimed ?? "0";
  const pending = overrides.pending ?? "0";
  return {
    root: `0x${"0".repeat(64)}`,
    distributionChainId: 1,
    amount,
    claimed,
    pending,
    proofs: [],
    recipient: "0x1234567890123456789012345678901234567890",
    token: {
      chainId: 1,
      address: "0x2222222222222222222222222222222222222222",
      decimals: 18,
      symbol: "crvUSD",
      price: 0.5,
      ...overrides.token,
    },
    breakdowns: [
      {
        root: `0x${"0".repeat(64)}`,
        distributionChainId: 1,
        reason: "test",
        amount,
        claimed,
        pending,
        campaignId: YLD_CAMPAIGN_ID,
      },
    ],
  };
}

const liveOpportunity: MerklOpportunity = {
  identifier: "0x0000000000000000000000000000000000000003",
  name: "Yld Borrow crvUSD",
  status: "LIVE",
  chainId: 1,
  type: "ENCOMPASSING",
  apr: 12.34,
  tvl: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localStorage.getItem).mockReset();
  sessionStorage.clear();
  settingsState.showSimulationPreview = false;
  mockUseIdle.mockReturnValue(false);
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

  it("never sends a deposit after an empty simulation preview", async () => {
    settingsState.showSimulationPreview = true;
    setup({ depositResult: null });

    typeAmount("10");
    await act(async () => {
      fireEvent.click(actionButton("Deposit"));
    });

    expect(deposit).toHaveBeenCalledTimes(1);
    expect(deposit).toHaveBeenCalledWith("10", expect.objectContaining({ previewOnly: true }));
    expect(deposit.mock.calls.some((call) => call.length === 1)).toBe(false);
    expect(screen.queryByTestId("simulation-modal")).toBeNull();
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

  it("never sends a withdrawal after an empty simulation preview", async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "yldfi-active-tab" ? "withdraw" : null,
    );
    settingsState.showSimulationPreview = true;
    setup({ withdrawResult: null });

    typeAmount("40");
    await act(async () => {
      fireEvent.click(actionButton("Withdraw"));
    });

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw).toHaveBeenCalledWith("40", expect.objectContaining({ previewOnly: true }));
    expect(withdraw.mock.calls.some((call) => call.length === 1)).toBe(false);
    expect(screen.queryByTestId("simulation-modal")).toBeNull();
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

describe("VaultPageContent rewards banner", () => {
  const rewardsVault = VAULTS.ycvxcrv;

  function rewardsBanner(): HTMLElement | null {
    return screen.queryByRole("link", { name: /crvUSD Rewards/ });
  }

  /**
   * Mocks the vault config with the rewards vault's deprecated flag lifted.
   * `getVault` reads the module's own `VAULTS`, so it has to be pointed at the
   * patched vault as well. Call `vi.resetModules()` first.
   */
  async function mockRewardsVaultWithoutDeprecation() {
    vi.doMock("@/config/vaults", async () => {
      const actual = await vi.importActual<typeof import("@/config/vaults")>(
        "@/config/vaults",
      );
      const vault = { ...actual.VAULTS.ycvxcrv, deprecated: undefined };
      return {
        ...actual,
        VAULTS: { ...actual.VAULTS, ycvxcrv: vault },
        getVault: (id: string) =>
          id.toLowerCase() === "ycvxcrv" ? vault : actual.getVault(id),
      };
    });
  }

  it("does not render the banner on the deprecated vault without earnings", () => {
    setup({ vault: rewardsVault });

    expect(rewardsBanner()).toBeNull();
  });

  it("shows the unclaimed plus pending total of a priced yld-campaign reward", () => {
    setup({
      vault: rewardsVault,
      merklRewards: [
        yldReward({
          amount: "3000000000000000000",
          claimed: "1000000000000000000",
          pending: "2000000000000000000",
        }),
      ],
    });

    // (3 − 1 + 2) × $0.50 = $2.00
    expect(screen.getByText("Earning $2.00")).toBeTruthy();
  });

  it("counts only the priced reward when another has no price", () => {
    setup({
      vault: rewardsVault,
      merklRewards: [
        yldReward({ token: { symbol: "UNK", price: undefined } }),
        yldReward(),
      ],
    });

    expect(screen.getByText("Earning $1.00")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("values a crvUSD reward without a price at $1", () => {
    setup({
      vault: rewardsVault,
      merklRewards: [yldReward({ token: { price: undefined } })],
    });

    expect(screen.getByText("Earning $2.00")).toBeTruthy();
  });

  it("shows only the pending amount when claimed runs ahead of amount", () => {
    setup({
      vault: rewardsVault,
      merklRewards: [
        yldReward({
          amount: "0",
          claimed: "2000000000000000000",
          pending: "1000000000000000000",
          token: { price: 1 },
        }),
      ],
    });

    expect(screen.getByText("Earning $1.00")).toBeTruthy();
  });

  it("adds the live campaign APR when the opportunity is live", () => {
    setup({
      vault: rewardsVault,
      merklRewards: [yldReward()],
      merklOpportunities: [liveOpportunity],
    });

    expect(screen.getByText("Earning $1.00")).toBeTruthy();
    expect(screen.getByText("12.3% APR")).toBeTruthy();
  });

  it("does not render the banner on another vault with the same earnings", () => {
    setup({ merklRewards: [yldReward()] });

    expect(rewardsBanner()).toBeNull();
  });

  it("does not render the banner on a non-deprecated rewards vault without a campaign", async () => {
    // The only vault with the banner is deprecated, and that flag alone hides
    // it, so the campaign condition can only be exercised with the flag lifted.
    vi.resetModules();
    mockRewardsVaultWithoutDeprecation();

    try {
      const { VaultPageContent: FreshVaultPageContent } = await import(
        "@/components/VaultPageContent"
      );
      installDefaultHooks({ vault: rewardsVault });
      render(<FreshVaultPageContent id={rewardsVault.id} />);

      expect(rewardsBanner()).toBeNull();
    } finally {
      vi.doUnmock("@/config/vaults");
      vi.resetModules();
    }
  });

  it("shows the live campaign APR on a non-deprecated rewards vault", async () => {
    vi.resetModules();
    mockRewardsVaultWithoutDeprecation();

    try {
      const { VaultPageContent: FreshVaultPageContent } = await import(
        "@/components/VaultPageContent"
      );
      installDefaultHooks({
        vault: rewardsVault,
        merklOpportunities: [liveOpportunity],
      });
      render(<FreshVaultPageContent id={rewardsVault.id} />);

      expect(screen.getByText("12.3% APR")).toBeTruthy();
      expect(screen.getByText("View rewards")).toBeTruthy();
    } finally {
      vi.doUnmock("@/config/vaults");
      vi.resetModules();
    }
  });
});

describe("zap tab quote gate and preview", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "yldfi-active-tab" ? "zap" : null,
    );
  });

  afterEach(() => {
    mockUseDebouncedValue.mockImplementation((value: unknown) => value);
  });

  /** Render the zap tab with a quote built from the amount the hook was given. */
  function renderZapTab(
    quoteInputAmount: (debouncedAmount: string) => string = (amount) => amount,
    executeZap?: (...args: unknown[]) => Promise<unknown>,
  ) {
    installDefaultHooks();
    if (executeZap) installZapActions(executeZap);
    mockUseZapQuote.mockImplementation(((params) => {
      const quote = params.inputToken
        ? {
            inputToken: params.inputToken,
            inputAmount: quoteInputAmount(params.inputAmount),
            outputAmount: "0",
            outputAmountFormatted: "0.4",
            exchangeRate: 0.8,
            inputUsdValue: 0,
            outputUsdValue: 0,
            priceImpact: 0,
            gasEstimate: "",
            tx: { to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" },
            route: [],
          }
        : null;
      return {
        quote,
        quoteUpdatedAt: Date.now(),
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useZapQuote>;
    }) as typeof useZapQuote);
    render(<VaultPageContent id={vaultUnderTest.id} />);
  }

  function installZapActions(executeZap: (...args: unknown[]) => Promise<unknown>) {
    mockUseZapActions.mockReturnValue({
      needsApproval: () => false,
      approve: vi.fn(),
      executeZap,
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
  }

  /** The action button, not the identical "Zap In"/"Zap Out" direction toggle. */
  function zapActionButton(name: string | RegExp): HTMLButtonElement {
    const button = screen
      .getAllByRole("button", { name })
      .find((candidate) => candidate.className.includes("w-full"));
    if (!button) throw new Error("zap action button not found");
    return button as HTMLButtonElement;
  }

  it("previews and sends only the quote built for the typed amount", () => {
    renderZapTab();

    typeAmount("0.5");

    expect(mockUseZapActions.mock.calls.at(-1)?.[0]).toMatchObject({ inputAmount: "0.5" });
    expect(mockUseZapActions.mock.calls.at(-1)?.[0]).not.toBeNull();
    expect(zapActionButton("Zap In").disabled).toBe(false);
  });

  it("withholds a quote built for a different amount and disables the button", () => {
    renderZapTab(() => "0.25");

    typeAmount("0.5");

    expect(mockUseZapActions.mock.calls.at(-1)?.[0]).toBeNull();
    expect(zapActionButton(/Getting quote/).disabled).toBe(true);
  });

  it("disables the button while the typed amount is not yet debounced", () => {
    mockUseDebouncedValue.mockReturnValue("0.25");
    renderZapTab();

    typeAmount("0.5");

    expect(mockUseZapActions.mock.calls.at(-1)?.[0]).toBeNull();
    expect(zapActionButton(/Getting quote/).disabled).toBe(true);
  });

  it("never sends after an empty simulation preview", async () => {
    settingsState.showSimulationPreview = true;
    const executeZap = vi.fn(async (...args: unknown[]) => {
      const options = args[0] as { previewOnly?: boolean } | undefined;
      return options?.previewOnly ? null : "0xhash";
    });
    renderZapTab(undefined, executeZap);

    typeAmount("0.5");
    await act(async () => {
      fireEvent.click(zapActionButton("Zap In"));
    });

    expect(executeZap.mock.calls).toEqual([[{ previewOnly: true }]]);
    expect(executeZap.mock.calls.some((call) => call.length === 0)).toBe(false);
  });
});

describe("zap tab send paths", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "yldfi-active-tab" ? "zap" : null,
    );
  });

  afterEach(() => {
    mockUseDebouncedValue.mockImplementation((value: unknown) => value);
  });

  type ZapSetupOptions = {
    priceImpact?: number;
    quoteUpdatedAt?: number;
    needsApproval?: boolean;
    pendingApproval?: PendingApproval | null;
    status?: ReturnType<typeof useZapActions>["status"];
    executeZap?: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
    getSimulationResult?: () => unknown;
    direction?: "in" | "out";
    vaultDecimals?: number;
    zapBalanceUnknown?: boolean;
    vaultBalanceUnknown?: boolean;
    zapActions?: Partial<ReturnType<typeof useZapActions>>;
  };

  /** Render the zap tab with a current quote and the zap action hook under test. */
  function renderZapTab(options: ZapSetupOptions = {}) {
    const {
      priceImpact = 0,
      quoteUpdatedAt = Date.now(),
      needsApproval = false,
      pendingApproval = null,
      status = "idle",
      getSimulationResult = () => null,
      direction = "in",
      vaultDecimals,
      zapBalanceUnknown = false,
      vaultBalanceUnknown = false,
    } = options;
    const executeZap = options.executeZap ?? vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
    const zapApprove = vi.fn(async () => undefined);
    const refetch = vi.fn();

    if (direction === "out") {
      sessionStorage.setItem(`yldfi-zap-direction-${vaultUnderTest.id}`, "out");
    }

    installDefaultHooks();
    if (zapBalanceUnknown) {
      mockUseBalance.mockReturnValue({
        data: undefined,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useBalance>);
    }
    if (vaultDecimals !== undefined) {
      mockUseVaultBalance.mockReturnValue({
        balance: DEFAULT_SHARE_BALANCE,
        decimals: vaultDecimals,
        formatted: formatUnits(DEFAULT_SHARE_BALANCE, vaultDecimals),
        formattedUsd: "$0",
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useVaultBalance>);
    }
    if (vaultBalanceUnknown) {
      mockUseVaultBalance.mockReturnValue({
        balance: undefined as unknown as bigint,
        decimals: vaultDecimals ?? TOKEN_DECIMALS,
        formatted: "0",
        formattedUsd: "$0",
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useVaultBalance>);
    }

    mockUseZapQuote.mockImplementation(((params) => {
      const hasQuote = !!(params.inputToken || params.outputToken);
      const quoteInputToken = params.inputToken ?? {
        address: vaultUnderTest.address,
        chainId: 1,
        name: vaultUnderTest.name,
        symbol: vaultUnderTest.symbol,
        decimals: TOKEN_DECIMALS,
        type: "defi",
      };
      return {
        quote: hasQuote
          ? {
              inputToken: quoteInputToken,
              inputAmount: params.inputAmount,
              outputAmount: "0",
              outputAmountFormatted: "0.4",
              exchangeRate: 0.8,
              inputUsdValue: 0,
              outputUsdValue: 0,
              priceImpact,
              gasEstimate: "",
              tx: { to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" },
              route: [],
            }
          : null,
        quoteUpdatedAt,
        isLoading: false,
        error: null,
        refetch,
      };
    }) as typeof useZapQuote);
    mockUseZapActions.mockImplementation((() => ({
      needsApproval: () => needsApproval,
      approve: zapApprove,
      executeZap,
      reset: vi.fn(),
      status,
      error: null,
      isLoading: false,
      isSuccess: false,
      isReverted: false,
      zapHash: undefined,
      pendingApproval,
      approvalProgress: null,
      isApproving: false,
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      toggleFlashbots: vi.fn(),
      simulationResult: getSimulationResult(),
      isSimulationForCurrentQuote: () => true,
      safePending: null,
      batchesApproval: false,
      ...options.zapActions,
    })) as unknown as typeof useZapActions);
    const utils = render(<VaultPageContent id={vaultUnderTest.id} />);
    return { ...utils, executeZap, zapApprove, refetch };
  }

  /** The action button, not the identical "Zap In"/"Zap Out" direction toggle. */
  function zapActionButton(name: string | RegExp): HTMLButtonElement {
    const button = screen
      .getAllByRole("button", { name })
      .find((candidate) => candidate.className.includes("w-full"));
    if (!button) throw new Error("zap action button not found");
    return button as HTMLButtonElement;
  }

  /** Type CONFIRM into the price-impact modal and click its confirm button. */
  function confirmHighImpact(label: string) {
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Type CONFIRM to proceed"), {
      target: { value: "CONFIRM" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
  }

  it("opens the typed-CONFIRM modal for a high-impact zap and sends only after CONFIRM", () => {
    const { executeZap } = renderZapTab({ priceImpact: 5 });

    typeAmount("0.5");
    fireEvent.click(zapActionButton("Zap In"));

    expect(screen.getByText("High Price Impact Warning")).toBeTruthy();
    expect(executeZap).not.toHaveBeenCalled();

    confirmHighImpact("Zap In");

    expect(executeZap).toHaveBeenCalledTimes(1);
    expect(executeZap.mock.calls[0]).toEqual([]);
  });

  it("gates the zap approval button behind the same typed CONFIRM modal", () => {
    const pendingApproval: PendingApproval = {
      token: "0x0000000000000000000000000000000000000002",
      tokenSymbol: "CVX",
      spender: "0x0000000000000000000000000000000000000003",
      amount: parseUnits("0.5", TOKEN_DECIMALS),
      decimals: TOKEN_DECIMALS,
    };
    const { zapApprove } = renderZapTab({
      priceImpact: 5,
      needsApproval: true,
      pendingApproval,
      status: "needsApproval",
    });

    typeAmount("0.5");
    fireEvent.click(screen.getByRole("button", { name: /^Exact/ }));

    expect(screen.getByText("High Price Impact Warning")).toBeTruthy();
    expect(zapApprove).not.toHaveBeenCalled();

    confirmHighImpact("Approve & zap");

    expect(zapApprove).toHaveBeenCalledTimes(1);
    expect(zapApprove).toHaveBeenCalledWith(true);
  });

  it("sends once with no arguments when previews are off", () => {
    const { executeZap } = renderZapTab();

    typeAmount("0.5");
    fireEvent.click(zapActionButton("Zap In"));

    expect(executeZap).toHaveBeenCalledTimes(1);
    expect(executeZap.mock.calls[0]).toEqual([]);
  });

  it("sends only from the simulation confirm with skipSimulation when previews are on", async () => {
    settingsState.showSimulationPreview = true;
    const simulationResult = {
      success: true,
      gasUsed: null,
      errorMessage: null,
      simulationId: null,
      tenderlyUrl: null,
      assetChanges: [],
    };
    let previewResult: unknown = null;
    const executeZap = vi.fn(async (...args: unknown[]) => {
      const options = args[0] as { previewOnly?: boolean } | undefined;
      if (options?.previewOnly) {
        previewResult = simulationResult;
        return simulationResult;
      }
      return null;
    });
    renderZapTab({ executeZap, getSimulationResult: () => previewResult });

    typeAmount("0.5");
    await act(async () => {
      fireEvent.click(zapActionButton("Zap In"));
    });

    expect(executeZap).toHaveBeenCalledWith({ previewOnly: true });
    expect(screen.getByTestId("simulation-modal")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm Zap" }));

    expect(executeZap).toHaveBeenCalledWith({ skipSimulation: true });
    expect(executeZap.mock.calls.some((call) => call.length === 0)).toBe(false);
  });

  it("refreshes instead of sending when the quote is older than the freshness limit", () => {
    const { executeZap, refetch } = renderZapTab({
      quoteUpdatedAt: Date.now() - 120_000,
    });

    typeAmount("0.5");
    fireEvent.click(zapActionButton("Zap In"));

    expect(refetch).toHaveBeenCalled();
    expect(executeZap).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it("refreshes instead of running the impact action when the quote aged while the modal was open", () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { executeZap, refetch } = renderZapTab({ priceImpact: 5, quoteUpdatedAt: now });

      typeAmount("0.5");
      fireEvent.click(zapActionButton("Zap In"));
      expect(screen.getByText("High Price Impact Warning")).toBeTruthy();

      nowSpy.mockReturnValue(now + 120_000);
      confirmHighImpact("Zap In");

      expect(refetch).toHaveBeenCalled();
      expect(executeZap).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("refreshes instead of sending from the simulation confirm when the quote aged", async () => {
    settingsState.showSimulationPreview = true;
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const simulationResult = {
        success: true,
        gasUsed: null,
        errorMessage: null,
        simulationId: null,
        tenderlyUrl: null,
        assetChanges: [],
      };
      let previewResult: unknown = null;
      const executeZap = vi.fn(async (...args: unknown[]) => {
        const options = args[0] as { previewOnly?: boolean } | undefined;
        if (options?.previewOnly) {
          previewResult = simulationResult;
          return simulationResult;
        }
        return null;
      });
      const { refetch } = renderZapTab({
        quoteUpdatedAt: now,
        executeZap,
        getSimulationResult: () => previewResult,
      });

      typeAmount("0.5");
      await act(async () => {
        fireEvent.click(zapActionButton("Zap In"));
      });
      expect(screen.getByTestId("simulation-modal")).toBeTruthy();

      nowSpy.mockReturnValue(now + 120_000);
      fireEvent.click(screen.getByRole("button", { name: "Confirm Zap" }));

      expect(refetch).toHaveBeenCalled();
      expect(executeZap).toHaveBeenCalledWith({ previewOnly: true });
      expect(executeZap).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stops the 60 s re-quote while idle", () => {
    mockUseIdle.mockReturnValue(true);

    renderZapTab();

    expect(mockUseZapQuote.mock.calls.at(-1)?.[0]).toMatchObject({ autoRefresh: false });
  });

  it("keeps the 60 s re-quote while active", () => {
    mockUseIdle.mockReturnValue(false);

    renderZapTab();

    expect(mockUseZapQuote.mock.calls.at(-1)?.[0]).toMatchObject({ autoRefresh: true });
  });

  /** Swap the zap action hook's state without re-rendering the whole page setup. */
  function installZapState(overrides: Partial<ReturnType<typeof useZapActions>>) {
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
      ...overrides,
    } as unknown as ReturnType<typeof useZapActions>);
  }

  it("blocks a zap-in until the input balance is known", () => {
    renderZapTab({ zapBalanceUnknown: true });

    typeAmount("0.5");

    const button = zapActionButton("Insufficient balance");
    expect(button.disabled).toBe(true);
  });

  it("blocks a zap-out until the vault share balance is known", () => {
    renderZapTab({ direction: "out", vaultBalanceUnknown: true });

    typeAmount("0.5");

    const button = zapActionButton("Insufficient balance");
    expect(button.disabled).toBe(true);
  });

  it("uses the vault decimals for the zap-out approval amount", () => {
    const pendingApproval: PendingApproval = {
      token: "0x0000000000000000000000000000000000000002",
      tokenSymbol: vaultUnderTest.symbol,
      spender: "0x0000000000000000000000000000000000000003",
      amount: 1_500_000n,
    };
    renderZapTab({
      direction: "out",
      vaultDecimals: 6,
      needsApproval: true,
      pendingApproval,
      status: "needsApproval",
    });

    expect(screen.getByText(/Exact · 1\.5/)).toBeTruthy();
    expect(screen.queryByText(/Exact · 0 /)).toBeNull();
  });

  it("clears the zap pending details when the zap action errors", async () => {
    const { rerender, executeZap } = renderZapTab();

    typeAmount("0.5");
    await act(async () => {
      fireEvent.click(zapActionButton("Zap In"));
    });
    expect(executeZap).toHaveBeenCalled();

    const pending = { status: "zapping" as const, isLoading: true };
    installZapState(pending);
    rerender(<VaultPageContent id={vaultUnderTest.id} />);
    expect(screen.getByTestId("tx-pending-card").getAttribute("data-details-symbol")).toBe("ETH");

    installZapState({ status: "error", error: "Zap failed", isLoading: false });
    rerender(<VaultPageContent id={vaultUnderTest.id} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    installZapState(pending);
    rerender(<VaultPageContent id={vaultUnderTest.id} />);
    expect(screen.getByTestId("tx-pending-card").getAttribute("data-details-symbol")).toBe("");
  });

  it("shows the checking and waiting approval labels on the zap button", () => {
    const checking = renderZapTab({ status: "checkingApproval" });
    typeAmount("0.5");
    expect(zapActionButton(/Checking approval/).disabled).toBe(false);
    checking.unmount();

    renderZapTab({ status: "waitingApproval" });
    typeAmount("0.5");
    expect(zapActionButton(/Waiting for approval/).disabled).toBe(false);
  });

  it("shows the Safe signature count on the zap button", () => {
    renderZapTab({
      status: "waitingApproval",
      zapActions: {
        safePending: {
          isAwaitingExecution: true,
          confirmations: 2,
          confirmationsRequired: 3,
          executedHash: null,
          outcome: null,
        },
      },
    });

    const button = zapActionButton(/Waiting for Safe/);
    expect(button.textContent).toContain("(2/3 signed)");
  });

  it("labels a batched zap approval as Approve & zap", () => {
    renderZapTab({ needsApproval: true, zapActions: { batchesApproval: true } });

    typeAmount("0.5");

    expect(zapActionButton("Approve & zap").disabled).toBe(false);
  });

  it("passes the ETH price and simulation-unavailable copy to the zap preview", async () => {
    settingsState.showSimulationPreview = true;
    const simulationResult = {
      success: true,
      gasUsed: 100,
      errorMessage: null,
      tenderlyUrl: null,
      assetChanges: [],
      simulationUnavailable: true,
      simulationUnavailableReason: "Tenderly key missing",
    };
    renderZapTab({ getSimulationResult: () => simulationResult });

    await waitFor(() => {
      expect(screen.getByTestId("simulation-modal").getAttribute("data-eth-price")).toBe("1");
    });
    const modal = screen.getByTestId("simulation-modal");
    expect(modal.getAttribute("data-simulation-unavailable")).toBe("true");
    expect(modal.getAttribute("data-simulation-unavailable-reason")).toBe("Tenderly key missing");
  });
});
