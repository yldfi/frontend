import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useReadContracts, useWaitForTransactionReceipt } from "wagmi";

import { VaultHarvestPanel } from "@/components/VaultHarvestPanel";
import { PERMISSIONLESS_KEEPER } from "@/config/harvest";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { useDirectWriteContract } from "@/hooks/useDirectWriteContract";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useReadContracts: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }));
vi.mock("@/hooks/useDirectWriteContract", () => ({ useDirectWriteContract: vi.fn() }));
vi.mock("@/hooks/useTokenMetadata", () => ({ useTokenMetadata: () => ({ token: null }) }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));

const mockUseAccount = vi.mocked(useAccount);
const mockUseReadContracts = vi.mocked(useReadContracts);
const mockUseReceipt = vi.mocked(useWaitForTransactionReceipt);
const mockUseDirectWrite = vi.mocked(useDirectWriteContract);
const writeContractAsync = vi.fn(async () => "0x123" as `0x${string}`);
const refetch = vi.fn();

describe("VaultHarvestPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({ isConnected: true } as ReturnType<typeof useAccount>);
    mockUseReceipt.mockReturnValue({ isLoading: false, isSuccess: false } as ReturnType<typeof useWaitForTransactionReceipt>);
    mockUseDirectWrite.mockReturnValue({
      writeContractAsync,
      data: undefined,
      status: "idle",
      error: null,
      reset: vi.fn(),
    } as unknown as ReturnType<typeof useDirectWriteContract>);
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

    expect(screen.getByText("16.4138 cvxCRV")).toBeTruthy();
    expect(screen.getByText("4.2 cvxCRV")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Harvest" }));
    expect(writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({
      address: PERMISSIONLESS_KEEPER,
      functionName: "report",
      args: [VAULT_ADDRESSES.YSCVX],
    }));
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

    expect(screen.getByText("2 CVG")).toBeTruthy();
    expect(screen.getByText("3 CVX")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send to auction" })).toBeNull();
  });
});
