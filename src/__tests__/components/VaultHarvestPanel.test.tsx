import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { stringToHex } from "viem";

import { VaultHarvestPanel } from "@/components/VaultHarvestPanel";
import { CVGCVX_STRATEGY_TRIGGER, PERMISSIONLESS_KEEPER } from "@/config/harvest";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { useDirectWriteContract } from "@/hooks/useDirectWriteContract";
import { useVaultCache } from "@/hooks/useVaultCache";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useReadContract: vi.fn(),
  useReadContracts: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }));
vi.mock("@/hooks/useDirectWriteContract", () => ({ useDirectWriteContract: vi.fn() }));
vi.mock("@/hooks/useVaultCache", () => ({ useVaultCache: vi.fn() }));
vi.mock("@/hooks/useTokenMetadata", () => ({ useTokenMetadata: () => ({ token: null }) }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));

const mockUseAccount = vi.mocked(useAccount);
const mockUseReadContract = vi.mocked(useReadContract);
const mockUseReadContracts = vi.mocked(useReadContracts);
const mockUseReceipt = vi.mocked(useWaitForTransactionReceipt);
const mockUseDirectWrite = vi.mocked(useDirectWriteContract);
const mockUseVaultCache = vi.mocked(useVaultCache);
const writeContractAsync = vi.fn(async () => "0x123" as `0x${string}`);
const refetch = vi.fn();

describe("VaultHarvestPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/vaults/yscvx");
    mockUseAccount.mockReturnValue({
      isConnected: true,
      address: "0x0000000000000000000000000000000000000002",
    } as unknown as ReturnType<typeof useAccount>);
    mockUseReceipt.mockReturnValue({ isLoading: false, isSuccess: false } as ReturnType<typeof useWaitForTransactionReceipt>);
    mockUseReadContract.mockReturnValue({ data: undefined, refetch } as unknown as ReturnType<typeof useReadContract>);
    mockUseDirectWrite.mockReturnValue({
      writeContractAsync,
      data: undefined,
      status: "idle",
      error: null,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useDirectWriteContract>);
    mockUseVaultCache.mockReturnValue({
      data: {
        cvxCrvPrice: 0.05,
        cvxPrice: 1,
        cvgCvxPrice: 0.8,
        pxCvxPrice: 0.9,
      },
    } as unknown as ReturnType<typeof useVaultCache>);
  });

  it("links a wallet without the payment token to a prefilled Zap", () => {
    vi.stubEnv("NODE_ENV", "development");
    window.history.replaceState({}, "", "/vaults/yscvx?auction-preview=no-balance");
    mockUseReadContracts.mockReturnValue({ data: [], isLoading: false, refetch } as unknown as ReturnType<typeof useReadContracts>);

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);

    const link = screen.getByRole("link", { name: "Buy CVX" });
    expect(link.getAttribute("href")).toContain("/zap?input=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(link.getAttribute("href")).toContain(`output=${TOKENS.CVX}`);
    expect(link.getAttribute("href")).toContain("outputAmount=150");
  });

  it("shows ysCVX pending cvxCRV and submits report through the permissionless keeper", () => {
    mockUseReadContracts.mockReturnValue({
      data: [
        { status: "success", result: 16413800000000000000n },
        { status: "success", result: [true, "0x"] },
        { status: "success", result: 4200000000000000000n },
      ],
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useReadContracts>);

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);

    expect(mockUseReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      contracts: expect.arrayContaining([
        expect.objectContaining({
          functionName: "strategyReportTrigger",
          args: [VAULT_ADDRESSES.YSCVX],
        }),
      ]),
    }));
    expect(screen.getByText("16.4138 cvxCRV")).toBeTruthy();
    expect(screen.getByText("4.2 cvxCRV")).toBeTruthy();
    expect(screen.getByLabelText("Auction route cvxCRV to CVX")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Harvest for vault" }));
    expect(writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({
      address: PERMISSIONLESS_KEEPER,
      functionName: "report",
      args: [VAULT_ADDRESSES.YSCVX],
    }));
  });

  it("explains why claiming is disabled when the report interval has not passed", () => {
    mockUseReadContracts.mockReturnValue({
      data: [
        { status: "success", result: 16413800000000000000n },
        { status: "success", result: [false, "0x2606a10b"] },
        { status: "success", result: 0n },
        { status: "success", result: 1787613911n },
        { status: "success", result: 259200n },
      ],
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useReadContracts>);

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);

    expect(screen.getByRole("button", { name: "Harvest for vault" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/The strategy can harvest these rewards around/)).toBeTruthy();
    expect(screen.getByText("No strategy-owned tokens are waiting for an auction.")).toBeTruthy();
  });

  it("shows progress toward the minimum reward threshold", () => {
    mockUseReadContract.mockImplementation((parameters) => ({
      data: parameters?.functionName === "minAmountToSell" ? 100n * 10n ** 18n : undefined,
      refetch,
    }) as unknown as ReturnType<typeof useReadContract>);
    mockUseReadContracts.mockReturnValue({
      data: [
        { status: "success", result: 16413800000000000000n },
        { status: "success", result: [false, stringToHex("Not enough pending cvxCRV rewards")] },
        { status: "success", result: 0n },
        { status: "success", result: 0n },
        { status: "success", result: 864000n },
      ],
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useReadContracts>);

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);

    expect(screen.getByText("16.41 / 100 cvxCRV accumulated by the strategy. It needs more before it can harvest.")).toBeTruthy();
  });

  it("omits auction controls for yscvgCVX", () => {
    mockUseReadContracts.mockReturnValue({
      data: [
        { status: "success", result: [2n * 10n ** 18n, [{ token: TOKENS.CVX, amount: 3n * 10n ** 18n }]] },
        { status: "success", result: [true, "0x"] },
        { status: "success", result: 0n },
      ],
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useReadContracts>);

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVGCVX} />);

    expect(mockUseReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      contracts: expect.arrayContaining([
        expect.objectContaining({
          address: CVGCVX_STRATEGY_TRIGGER,
          functionName: "reportTrigger",
          args: [VAULT_ADDRESSES.YSCVGCVX],
        }),
      ]),
    }));
    expect(screen.getByText("2 CVG")).toBeTruthy();
    expect(screen.getByText("3 CVX")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start auction" })).toBeNull();
  });

  it("shows an active auction timeline and market-price comparison", () => {
    const kicked = BigInt(Math.floor(Date.now() / 1000) - 3_600);
    mockUseReadContract.mockImplementation((parameters) => ({
      data: parameters?.functionName === "auction" ? "0x0000000000000000000000000000000000000001" : undefined,
      refetch,
    }) as unknown as ReturnType<typeof useReadContract>);
    mockUseReadContracts.mockImplementation((parameters) => {
      const contracts = parameters?.contracts as readonly { functionName?: string }[] | undefined;
      const isAuctionStateRead = contracts?.[0]?.functionName === "isActive";
      return {
        data: isAuctionStateRead ? [
          { status: "success", result: true },
          { status: "success", result: 2500000000000000000n },
          { status: "success", result: kicked },
          { status: "success", result: 86400n },
          { status: "success", result: 60n * 10n ** 18n },
          { status: "success", result: 60n },
          { status: "success", result: 150n },
          { status: "success", result: [kicked, 1n, 100n * 10n ** 18n] },
          { status: "success", result: 10n ** 17n },
          { status: "success", result: 10n ** 17n },
          { status: "success", result: 0n },
        ] : [
          { status: "success", result: 16413800000000000000n },
          { status: "success", result: [false, stringToHex("Not enough pending cvxCRV rewards")] },
          { status: "success", result: 0n },
          { status: "success", result: 0n },
          { status: "success", result: 864000n },
        ],
        isLoading: false,
        refetch,
      } as unknown as ReturnType<typeof useReadContracts>;
    });

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);

    expect(screen.getByText("2.5 cvxCRV")).toBeTruthy();
    expect(screen.getByText("Auction in progress")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Auction in progress" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve CVX to participate" })).toBeTruthy();
    expect(screen.getByText(/If you’d like to participate, approve CVX first/)).toBeTruthy();
    expect(screen.getByLabelText("Auction timeline")).toBeTruthy();
    expect(screen.getByText("Auction will reach the current cvxCRV/CVX market price in ~2 hrs")).toBeTruthy();
    expect(screen.getByText("Auction now")).toBeTruthy();
    expect(screen.getByText("0.04 CVX")).toBeTruthy();
    expect(screen.getByText("Market")).toBeTruthy();
    expect(screen.getByText("≈ 0.05 CVX")).toBeTruthy();
  });

  it("allows a wallet with the payment token to take part of an attractive auction", () => {
    const account = "0x0000000000000000000000000000000000000002" as const;
    const auction = "0x0000000000000000000000000000000000000001" as const;
    const kicked = BigInt(Math.floor(Date.now() / 1000) - 4 * 3_600);
    mockUseAccount.mockReturnValue({ isConnected: true, address: account } as unknown as ReturnType<typeof useAccount>);
    mockUseReadContract.mockImplementation((parameters) => ({
      data: parameters?.functionName === "auction" ? auction : undefined,
      refetch,
    }) as unknown as ReturnType<typeof useReadContract>);
    mockUseReadContracts.mockImplementation((parameters) => {
      const contracts = parameters?.contracts as readonly { functionName?: string }[] | undefined;
      return {
        data: contracts?.[0]?.functionName === "isActive" ? [
          { status: "success", result: true },
          { status: "success", result: 25n * 10n ** 17n },
          { status: "success", result: kicked },
          { status: "success", result: 86400n },
          { status: "success", result: 60n * 10n ** 18n },
          { status: "success", result: 60n },
          { status: "success", result: 150n },
          { status: "success", result: [kicked, 1n, 100n * 10n ** 18n] },
          { status: "success", result: 10n ** 17n },
          { status: "success", result: 5n * 10n ** 16n },
          { status: "success", result: 5n * 10n ** 16n },
        ] : [
          { status: "success", result: 16413800000000000000n },
          { status: "success", result: [false, stringToHex("Not enough pending cvxCRV rewards")] },
          { status: "success", result: 0n },
          { status: "success", result: 0n },
          { status: "success", result: 864000n },
        ],
        isLoading: false,
        refetch,
      } as unknown as ReturnType<typeof useReadContracts>;
    });

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);

    expect(screen.getByText(/You can participate with up to/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Take .* with .*/ }));
    expect(writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({
      address: auction,
      functionName: "take",
      args: [TOKENS.CVXCRV, 1249999999999999987n, account],
    }));
  });

  it("warns before participating when the auction price is above market value", () => {
    const account = "0x0000000000000000000000000000000000000002" as const;
    const auction = "0x0000000000000000000000000000000000000001" as const;
    const kicked = BigInt(Math.floor(Date.now() / 1000) - 4 * 3_600);
    mockUseReadContract.mockImplementation((parameters) => ({
      data: parameters?.functionName === "auction" ? auction : undefined,
      refetch,
    }) as unknown as ReturnType<typeof useReadContract>);
    mockUseReadContracts.mockImplementation((parameters) => {
      const contracts = parameters?.contracts as readonly { functionName?: string }[] | undefined;
      return {
        data: contracts?.[0]?.functionName === "isActive" ? [
          { status: "success", result: true },
          { status: "success", result: 25n * 10n ** 17n },
          { status: "success", result: kicked },
          { status: "success", result: 86400n },
          { status: "success", result: 60n * 10n ** 18n },
          { status: "success", result: 60n },
          { status: "success", result: 150n },
          { status: "success", result: [kicked, 1n, 100n * 10n ** 18n] },
          { status: "success", result: 15n * 10n ** 16n },
          { status: "success", result: 15n * 10n ** 16n },
          { status: "success", result: 15n * 10n ** 16n },
        ] : [
          { status: "success", result: 16413800000000000000n },
          { status: "success", result: [false, stringToHex("Not enough pending cvxCRV rewards")] },
          { status: "success", result: 0n },
          { status: "success", result: 0n },
          { status: "success", result: 864000n },
        ],
        isLoading: false,
        refetch,
      } as unknown as ReturnType<typeof useReadContracts>;
    });

    render(<VaultHarvestPanel vaultAddress={VAULT_ADDRESSES.YSCVX} />);
    fireEvent.click(screen.getByRole("button", { name: /Take .* with .*/ }));

    const warningDialog = screen.getByRole("dialog", { name: "Auction price is above market value" });
    expect(warningDialog).toBeTruthy();
    expect(screen.getByText(/approximately 20% more than the estimated market price/)).toBeTruthy();
    expect(writeContractAsync).not.toHaveBeenCalled();

    fireEvent.click(within(warningDialog).getByRole("button", { name: /Take .* with .*/ }));
    expect(writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({
      address: auction,
      functionName: "take",
      args: [TOKENS.CVXCRV, 25n * 10n ** 17n, account],
    }));
  });
});
