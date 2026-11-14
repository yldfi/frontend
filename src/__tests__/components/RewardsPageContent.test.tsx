import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount, useWriteContract } from "wagmi";

import { RewardsPageContent } from "@/components/RewardsPageContent";
import {
  useMerklOpportunities,
  useMerklRewards,
  type MerklBreakdown,
  type MerklReward,
  type MerklRewardsResponse,
} from "@/hooks/useMerklRewards";
import { useTxReceipt } from "@/hooks/useTxReceipt";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { toast } from "sonner";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/Header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@/components/Footer", () => ({
  Footer: () => <div data-testid="footer" />,
}));

vi.mock("@/components/CustomConnectButton", () => ({
  CustomConnectButton: () => <div data-testid="connect-button" />,
}));

vi.mock("@/lib/analytics", () => ({
  trackRewardsPageView: vi.fn(),
  trackRewardsClaimClick: vi.fn(),
  trackRewardsEligibilityCheck: vi.fn(),
}));

vi.mock("@/hooks/useTxReceipt", () => ({
  useTxReceipt: vi.fn(),
}));

vi.mock("@/hooks/useVaultBalance", () => ({
  useVaultBalance: vi.fn(),
}));

// Keep the real campaign helpers so the page's yld/other split is exercised.
vi.mock("@/hooks/useMerklRewards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useMerklRewards")>();
  return {
    ...actual,
    useMerklRewards: vi.fn(),
    useMerklOpportunities: vi.fn(),
  };
});

const ACCOUNT = "0x1234567890123456789012345678901234567890";
const CRVUSD_TOKEN = "0x1111111111111111111111111111111111111111";
const UNPRICED_TOKEN = "0x5555555555555555555555555555555555555555";
const DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
// Built-in fallback campaign ID of the yld.fi opportunity.
const YLD_CAMPAIGN = "0xb12032fde1bfb5ba7a853ed91ddfb164764b0eb3813cbfa25799af06efe117be";
const OTHER_CAMPAIGN = "0x00000000000000000000000000000000000000000000000000000000000000ff";

const mockUseAccount = vi.mocked(useAccount);
const mockUseWriteContract = vi.mocked(useWriteContract);
const mockUseTxReceipt = vi.mocked(useTxReceipt);
const mockUseVaultBalance = vi.mocked(useVaultBalance);
const mockUseMerklRewards = vi.mocked(useMerklRewards);
const mockUseMerklOpportunities = vi.mocked(useMerklOpportunities);

const writeContract = vi.fn();

function breakdown(campaignId: string, amount: string, claimed: string): MerklBreakdown {
  return {
    root: "0xroot",
    distributionChainId: 1,
    reason: "test",
    amount,
    claimed,
    pending: "0",
    campaignId,
  };
}

function reward(overrides: Partial<MerklReward> = {}): MerklReward {
  return {
    root: "0xroot",
    distributionChainId: 1,
    amount: "5000000000000000000",
    claimed: "2000000000000000000",
    pending: "0",
    proofs: ["0xproof"],
    recipient: ACCOUNT,
    token: {
      chainId: 1,
      address: CRVUSD_TOKEN,
      decimals: 18,
      symbol: "crvUSD",
      price: 1,
    },
    breakdowns: [],
    ...overrides,
  };
}

function setup(rewards: MerklReward[]) {
  mockUseMerklRewards.mockReturnValue({
    data: [{ rewards }] as unknown as MerklRewardsResponse[],
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useMerklRewards>);
  return render(<RewardsPageContent />);
}

/** The reward card that shows `symbol`; the row is the only `rounded-lg p-5` box. */
function rowFor(symbol: string): HTMLElement {
  const symbolEl = screen.getByText(symbol);
  const row = symbolEl.closest("div.rounded-lg.p-5");
  if (!row) throw new Error(`no reward row found for ${symbol}`);
  return row as HTMLElement;
}

/**
 * The page total from the summary card. That card renders above the reward
 * rows, so its "Claimable" label is the first one in document order.
 */
function summaryClaimable(): string {
  const label = screen.getAllByText("Claimable")[0];
  return label.nextElementSibling?.textContent ?? "";
}

/** The value under a column label (Earned / Claimed / Claimable) inside a row. */
function columnValue(row: HTMLElement, label: string): string {
  return within(row).getByText(label).nextElementSibling?.textContent ?? "";
}

/** The USD line under a column's value, shown when the token has a price. */
function columnUsd(row: HTMLElement, label: string): string {
  const value = within(row).getByText(label).nextElementSibling;
  return value?.nextElementSibling?.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAccount.mockReturnValue({
    address: ACCOUNT,
    isConnected: true,
  } as unknown as ReturnType<typeof useAccount>);
  mockUseWriteContract.mockReturnValue({
    writeContract,
    data: undefined,
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof useWriteContract>);
  mockUseTxReceipt.mockReturnValue({
    data: undefined,
    isLoading: false,
    isPending: false,
    isSuccess: false,
    error: null,
    safe: null,
  } as unknown as ReturnType<typeof useTxReceipt>);
  mockUseVaultBalance.mockReturnValue({
    balance: 0n,
  } as unknown as ReturnType<typeof useVaultBalance>);
  mockUseMerklOpportunities.mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useMerklOpportunities>);
});

describe("RewardsPageContent claim row", () => {
  it("claims the cumulative amount, not the claimable difference", () => {
    const proofs = ["0xproof-a", "0xproof-b"];
    setup([
      reward({
        amount: "5000000000000000000",
        claimed: "2000000000000000000",
        proofs,
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Claim" }));

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith({
      address: DISTRIBUTOR,
      abi: expect.any(Array),
      functionName: "claim",
      args: [[ACCOUNT], [CRVUSD_TOKEN], [5000000000000000000n], [proofs]],
    });
  });

  it("shows no claim button once the whole amount is claimed", () => {
    setup([
      reward({
        amount: "2000000000000000000",
        claimed: "2000000000000000000",
      }),
    ]);

    expect(within(rowFor("crvUSD")).queryByRole("button")).toBeNull();
  });

  it("floors a row's claimable at zero when claimed exceeds amount", () => {
    setup([
      reward({
        amount: "2000000000000000000",
        claimed: "3000000000000000000",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(within(row).queryByRole("button")).toBeNull();
    const claimableLabel = within(row).getByText("Claimable");
    expect(claimableLabel.nextElementSibling?.textContent).toBe("0");
  });

  it("shows earned at least as large as claimed", () => {
    setup([
      reward({
        amount: "1000000000000000000",
        claimed: "3000000000000000000",
        pending: "0",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(columnValue(row, "Earned")).toBe("3");
    expect(columnValue(row, "Claimed")).toBe("3");
    expect(columnValue(row, "Claimable")).toBe("0");
  });

  it("labels a row with only pending rewards as Pending", () => {
    setup([
      reward({
        amount: "0",
        claimed: "0",
        pending: "2000000000000000000",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(columnValue(row, "Pending")).toBe("2");
  });

  it("labels a row Earned once anything was earned", () => {
    setup([
      reward({
        amount: "1000000000000000000",
        claimed: "0",
        pending: "2000000000000000000",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(columnValue(row, "Earned")).toBe("1");
  });

  it("shows the pending amount under a Pending label when nothing is claimable", () => {
    setup([
      reward({
        amount: "0",
        claimed: "2000000000000000000",
        pending: "1000000000000000000",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(columnValue(row, "Pending")).toBe("1");
    expect(columnUsd(row, "Pending")).toBe("$1.00");
    expect(columnValue(row, "Claimed")).toBe("2");
    expect(columnValue(row, "Claimable")).toBe("0");
  });

  it("shows the claimed amount under an Earned label when nothing is pending", () => {
    setup([
      reward({
        amount: "0",
        claimed: "2000000000000000000",
        pending: "0",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(columnValue(row, "Earned")).toBe("2");
  });

  it("shows zero under an Earned label when nothing was earned and nothing is pending", () => {
    setup([
      reward({
        amount: "0",
        claimed: "0",
        pending: "0",
      }),
    ]);

    const row = rowFor("crvUSD");
    expect(columnValue(row, "Earned")).toBe("0");
  });

  it("floors the page's claimable total at zero", () => {
    setup([
      reward({
        amount: "1000000000000000000",
        claimed: "3000000000000000000",
        token: {
          chainId: 1,
          address: "0x3333333333333333333333333333333333333333",
          decimals: 18,
          symbol: "AAA",
          price: 1,
        },
      }),
      reward({
        amount: "4000000000000000000",
        claimed: "0",
        token: {
          chainId: 1,
          address: "0x4444444444444444444444444444444444444444",
          decimals: 18,
          symbol: "BBB",
          price: 1,
        },
      }),
    ]);

    expect(summaryClaimable()).toBe("$4.00");
  });

  it("disables the button and asks to confirm while the write is pending", () => {
    mockUseWriteContract.mockReturnValue({
      writeContract,
      data: undefined,
      isPending: true,
      error: null,
    } as unknown as ReturnType<typeof useWriteContract>);
    setup([reward()]);

    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent?.startsWith("Confirm")).toBe(true);
  });

  it("disables the button and says claiming while the receipt loads", () => {
    mockUseTxReceipt.mockReturnValue({
      data: undefined,
      isLoading: true,
      isPending: true,
      isSuccess: false,
      error: null,
      safe: null,
    } as unknown as ReturnType<typeof useTxReceipt>);
    setup([reward()]);

    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent?.startsWith("Claiming")).toBe(true);
  });

  it("shows the claimed badge and a success toast after a successful receipt", () => {
    mockUseTxReceipt.mockReturnValue({
      data: { status: "success" },
      isLoading: false,
      isPending: false,
      isSuccess: true,
      error: null,
      safe: null,
    } as unknown as ReturnType<typeof useTxReceipt>);
    setup([reward()]);

    const row = rowFor("crvUSD");
    const header = row.firstElementChild as HTMLElement;
    expect(within(header).getByText("Claimed")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith(
      "Rewards claimed successfully!",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("keeps the claim button and warns when the receipt reverted", () => {
    mockUseTxReceipt.mockReturnValue({
      data: { status: "reverted" },
      isLoading: false,
      isPending: false,
      isSuccess: true,
      error: null,
      safe: null,
    } as unknown as ReturnType<typeof useTxReceipt>);
    setup([reward()]);

    const row = rowFor("crvUSD");
    const header = row.firstElementChild as HTMLElement;
    expect(within(header).queryByText("Claimed")).toBeNull();
    expect(within(header).getByRole("button", { name: "Claim" })).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("Claim failed: the transaction reverted");
  });

  it("toasts the first line of a write error", () => {
    mockUseWriteContract.mockReturnValue({
      writeContract,
      data: undefined,
      isPending: false,
      error: new Error("User rejected the request.\nDetails: MockProvider rejected the request"),
    } as unknown as ReturnType<typeof useWriteContract>);
    setup([reward()]);

    expect(toast.error).toHaveBeenCalledWith("User rejected the request.");
  });

  it("toasts a receipt error", () => {
    mockUseTxReceipt.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: false,
      isSuccess: false,
      error: new Error("receipt lookup failed"),
      safe: null,
    } as unknown as ReturnType<typeof useTxReceipt>);
    setup([reward()]);

    expect(toast.error).toHaveBeenCalledWith("Claim transaction failed");
  });

  it("renders one button for a token that appears in both campaign sections", () => {
    setup([
      reward({
        amount: "10000000000000000000",
        claimed: "2000000000000000000",
        breakdowns: [
          breakdown(YLD_CAMPAIGN, "6000000000000000000", "1000000000000000000"),
          breakdown(OTHER_CAMPAIGN, "4000000000000000000", "1000000000000000000"),
        ],
      }),
    ]);

    const yldSection = screen.getByText("yld.fi campaign rewards").closest("section") as HTMLElement;
    const otherSection = screen.getByText("Other Merkl rewards").closest("section") as HTMLElement;
    expect(within(yldSection).getAllByRole("button")).toHaveLength(1);
    expect(within(yldSection).getByRole("button", { name: "Claim all" })).toBeTruthy();
    expect(within(otherSection).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("values crvUSD without a price at $1 and other unpriced tokens at $0", () => {
    setup([
      reward({
        amount: "1000000000000000000",
        claimed: "0",
        token: {
          chainId: 1,
          address: CRVUSD_TOKEN,
          decimals: 18,
          symbol: "crvUSD",
          price: undefined as unknown as number,
        },
      }),
      reward({
        amount: "5000000000000000000",
        claimed: "0",
        token: {
          chainId: 1,
          address: UNPRICED_TOKEN,
          decimals: 18,
          symbol: "UNK",
          price: undefined as unknown as number,
        },
      }),
    ]);

    expect(summaryClaimable()).toBe("$1.00");
    expect(within(rowFor("UNK")).queryByText(/^\$/)).toBeNull();
  });

  it("shows the connect prompt and no reward rows when the wallet is not connected", () => {
    mockUseAccount.mockReturnValue({
      address: undefined,
      isConnected: false,
    } as unknown as ReturnType<typeof useAccount>);
    setup([reward()]);

    expect(screen.getByText("Connect your wallet to view rewards")).toBeTruthy();
    expect(screen.queryByText("crvUSD")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
    expect(writeContract).not.toHaveBeenCalled();
  });
});
