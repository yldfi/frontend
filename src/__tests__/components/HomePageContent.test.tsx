import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "wagmi";

import { HomePageContent } from "@/components/HomePageContent";
import { useVaultCache, type VaultCacheData, type VaultCacheResponse } from "@/hooks/useVaultCache";
import { useYearnVault } from "@/hooks/useYearnVault";
import { useMultipleVaultBalances } from "@/hooks/useVaultBalance";
import { useMultiplePricePerShare } from "@/hooks/usePricePerShare";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";
import { useCvxPrice } from "@/hooks/useCvxPrice";
import {
  getYldMerklCampaignIds,
  useMerklOpportunities,
  useMerklRewards,
  type MerklOpportunity,
  type MerklReward,
} from "@/hooks/useMerklRewards";
import { isVaultHiddenUnlessHolder, VAULT_ADDRESSES, VAULTS } from "@/config/vaults";
import { averageDisplayApy } from "@/lib/apy";

const mocks = vi.hoisted(() => ({
  useAccount: vi.fn(),
  useVaultCache: vi.fn(),
  useYearnVault: vi.fn(),
  useMultipleVaultBalances: vi.fn(),
  useMultiplePricePerShare: vi.fn(),
  useCvxCrvPrice: vi.fn(),
  useCvxPrice: vi.fn(),
  useMerklRewards: vi.fn(),
  useMerklOpportunities: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock("@/components/Header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@/components/Footer", () => ({
  Footer: () => <div data-testid="footer" />,
}));

vi.mock("@/components/PixelAnimation", () => ({
  PixelAnimation: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  trackCtaClick: vi.fn(),
  trackExternalLinkClick: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: mocks.useAccount,
  useReadContracts: vi.fn(),
  usePublicClient: vi.fn(),
}));

vi.mock("@/hooks/useVaultCache", () => ({
  useVaultCache: mocks.useVaultCache,
}));

vi.mock("@/hooks/useYearnVault", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useYearnVault")>(
    "@/hooks/useYearnVault",
  );
  return { ...actual, useYearnVault: mocks.useYearnVault };
});

vi.mock("@/hooks/useVaultBalance", () => ({
  useMultipleVaultBalances: mocks.useMultipleVaultBalances,
}));

vi.mock("@/hooks/usePricePerShare", () => ({
  useMultiplePricePerShare: mocks.useMultiplePricePerShare,
}));

vi.mock("@/hooks/useCvxCrvPrice", () => ({
  useCvxCrvPrice: mocks.useCvxCrvPrice,
}));

vi.mock("@/hooks/useCvxPrice", () => ({
  useCvxPrice: mocks.useCvxPrice,
}));

vi.mock("@/hooks/useMerklRewards", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useMerklRewards")>(
    "@/hooks/useMerklRewards",
  );
  return {
    ...actual,
    useMerklRewards: mocks.useMerklRewards,
    useMerklOpportunities: mocks.useMerklOpportunities,
  };
});

type VaultId = "ycvxcrv" | "yscvxcrv" | "yspxcvx" | "yscvx";
type YearnId = "ycvxcrv" | "yscvxcrv" | "yspxcvx";

interface YearnSpec {
  tvl: number;
  apyPct: number;
}

interface BalanceSpec {
  balance: bigint;
  formattedUsd: string;
  usdValue: number;
}

interface SetupOptions {
  /** `null` means the cache query has no data. */
  cache?: VaultCacheResponse | null;
  cacheLoading?: boolean;
  yearn?: Partial<Record<YearnId, YearnSpec>>;
  yearnLoading?: Partial<Record<YearnId, boolean>>;
  balances?: Partial<Record<VaultId, BalanceSpec>>;
  merklRewards?: MerklReward[];
  merklOpportunities?: MerklOpportunity[];
  connected?: boolean;
  sortStoredValue?: string;
}

const DEFAULT_TVL: Record<VaultId, number> = {
  ycvxcrv: 400_000,
  yscvxcrv: 1_500_000,
  yspxcvx: 0,
  yscvx: 250_000,
};

const DEFAULT_APY: Record<VaultId, number> = {
  ycvxcrv: 4,
  yscvxcrv: 9,
  yspxcvx: 0,
  yscvx: 12,
};

const BALANCE_ORDER: VaultId[] = ["ycvxcrv", "yscvxcrv", "yspxcvx", "yscvx"];

// Mirrors the component's module-level filter: hidden vaults are dropped
// outside development, and `test` is not development.
const visibleVaults = Object.values(VAULTS).filter((vault) => !vault.hidden);
const listedByDefault = visibleVaults.filter(
  (vault) => !isVaultHiddenUnlessHolder(vault),
);
const hiddenUnlessHolderVault = visibleVaults.find(isVaultHiddenUnlessHolder);

function cacheEntry(tvlUsd: number, apy: number): VaultCacheData {
  return {
    address: "0x0000000000000000000000000000000000000000",
    totalAssets: "0",
    pricePerShare: "1",
    tvl: tvlUsd,
    pps: 1,
    tvlUsd,
    apy,
  };
}

function makeCache(
  overrides: Partial<Record<VaultId, VaultCacheData>> = {},
): VaultCacheResponse {
  return {
    ycvxcrv: cacheEntry(DEFAULT_TVL.ycvxcrv, DEFAULT_APY.ycvxcrv),
    yscvxcrv: cacheEntry(DEFAULT_TVL.yscvxcrv, DEFAULT_APY.yscvxcrv),
    yspxcvx: cacheEntry(DEFAULT_TVL.yspxcvx, DEFAULT_APY.yspxcvx),
    yscvx: cacheEntry(DEFAULT_TVL.yscvx, DEFAULT_APY.yscvx),
    cvxCrvPrice: 0.5,
    pxCvxPrice: 0,
    cvxPrice: 5,
    lastUpdated: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

function yearnData(spec: YearnSpec) {
  return {
    vault: {
      chainId: 1,
      address: VAULT_ADDRESSES.YSCVXCRV,
      name: "Test Vault",
      symbol: "TV",
      asset: {
        address: "0x0000000000000000000000000000000000000000",
        name: "Test Asset",
        symbol: "TST",
        decimals: 18,
      },
      accountant: null,
      pricePerShare: "1000000000000000000",
      totalAssets: "0",
      totalDebt: "0",
      fees: { managementFee: 0, performanceFee: 0 },
      tvl: { close: spec.tvl },
      apy: {
        close: spec.apyPct / 100,
        grossApr: 0,
        weeklyNet: 0,
        monthlyNet: 0,
        inceptionNet: 0,
      },
      debts: [],
    },
    vaultStrategies: [],
  };
}

function yearnIdForAddress(address: string): YearnId | undefined {
  const normalized = address.toLowerCase();
  if (normalized === VAULT_ADDRESSES.YCVXCRV.toLowerCase()) return "ycvxcrv";
  if (normalized === VAULT_ADDRESSES.YSCVXCRV.toLowerCase()) return "yscvxcrv";
  if (normalized === VAULT_ADDRESSES.YSPXCVX.toLowerCase()) return "yspxcvx";
  return undefined;
}

function installMocks(options: SetupOptions = {}) {
  vi.mocked(useAccount).mockReturnValue({
    isConnected: options.connected ?? false,
    address: options.connected
      ? "0x1234567890123456789012345678901234567890"
      : undefined,
  } as unknown as ReturnType<typeof useAccount>);

  const cache = options.cache === undefined ? makeCache() : options.cache;
  vi.mocked(useVaultCache).mockReturnValue({
    data: cache ?? undefined,
    isLoading: options.cacheLoading ?? false,
  } as unknown as ReturnType<typeof useVaultCache>);

  const yearn = options.yearn ?? {};
  const yearnLoading = options.yearnLoading ?? {};
  vi.mocked(useYearnVault).mockImplementation((vaultAddress: string) => {
    const id = yearnIdForAddress(vaultAddress);
    const spec = id ? yearn[id] : undefined;
    return {
      data: spec ? yearnData(spec) : undefined,
      isLoading: id ? (yearnLoading[id] ?? false) : false,
    } as unknown as ReturnType<typeof useYearnVault>;
  });

  const balances = BALANCE_ORDER.map((id) => ({
    balance: 0n,
    formattedUsd: "$0",
    usdValue: 0,
    ...(options.balances?.[id] ?? {}),
  }));
  vi.mocked(useMultipleVaultBalances).mockReturnValue({
    balances,
  } as unknown as ReturnType<typeof useMultipleVaultBalances>);

  vi.mocked(useMultiplePricePerShare).mockReturnValue({
    prices: [],
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useMultiplePricePerShare>);

  vi.mocked(useCvxCrvPrice).mockReturnValue({
    price: 0,
    cvxCrvInCrvUsd: 0,
    crvUsdInUsd: 0,
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useCvxCrvPrice>);

  vi.mocked(useCvxPrice).mockReturnValue({
    price: 0,
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useCvxPrice>);

  vi.mocked(useMerklRewards).mockReturnValue({
    data: options.merklRewards
      ? [{ rewards: options.merklRewards }]
      : undefined,
  } as unknown as ReturnType<typeof useMerklRewards>);

  vi.mocked(useMerklOpportunities).mockReturnValue({
    data: options.merklOpportunities,
  } as unknown as ReturnType<typeof useMerklOpportunities>);

  vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
    key === "yldfi-vault-sort" ? (options.sortStoredValue ?? null) : null,
  );
}

function setup(options: SetupOptions = {}) {
  installMocks(options);
  return render(<HomePageContent />);
}

function statValue(label: string): string {
  const labelNode = screen.getByText(label);
  return labelNode.previousElementSibling?.textContent ?? "";
}

function rowIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a[href^="/vaults/"]')).map(
    (node) => (node.getAttribute("href") ?? "").replace("/vaults/", ""),
  );
}

function vaultRow(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`a[href="/vaults/${id}"]`);
}

function expectedOrder(
  values: Record<string, number>,
  vaults = listedByDefault,
): string[] {
  return [...vaults]
    .sort((a, b) => (values[b.id] ?? 0) - (values[a.id] ?? 0))
    .map((vault) => vault.id);
}

function highestBy(values: Record<string, number>): string {
  return expectedOrder(values)[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
});

describe("HomePageContent totals", () => {
  it("excludes the ycvxcrv vault from the total value locked", () => {
    setup();

    expect(statValue("Total Value Locked")).toBe("$1.75M");
  });

  it("does not count ycvxcrv even when its TVL is large", () => {
    setup({ cache: makeCache({ ycvxcrv: cacheEntry(10_000_000, 4) }) });

    expect(statValue("Total Value Locked")).toBe("$1.75M");
  });

  it("formats sub-thousand totals with two decimals", () => {
    setup({
      cache: makeCache({
        ycvxcrv: cacheEntry(0, 4),
        yscvxcrv: cacheEntry(999.5, 9),
        yscvx: cacheEntry(0, 12),
      }),
    });

    expect(statValue("Total Value Locked")).toBe("$999.50");
  });

  it("formats thousands totals with one decimal and a K suffix", () => {
    setup({
      cache: makeCache({
        ycvxcrv: cacheEntry(0, 4),
        yscvxcrv: cacheEntry(12_345, 9),
        yscvx: cacheEntry(0, 12),
      }),
    });

    expect(statValue("Total Value Locked")).toBe("$12.3K");
  });

  it("formats millions totals with two decimals and an M suffix", () => {
    setup({
      cache: makeCache({
        ycvxcrv: cacheEntry(0, 4),
        yscvxcrv: cacheEntry(2_500_000, 9),
        yscvx: cacheEntry(0, 12),
      }),
    });

    expect(statValue("Total Value Locked")).toBe("$2.50M");
  });
});

describe("HomePageContent data sources", () => {
  it("falls back to Yearn TVL and APY when the cache is missing", () => {
    const { container } = setup({
      cache: null,
      yearn: { yscvxcrv: { tvl: 3_000_000, apyPct: 6.5 } },
    });

    expect(statValue("Total Value Locked")).toBe("$3.00M");

    const row = vaultRow(container, "yscvxcrv");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getAllByText("$3.00M").length).toBeGreaterThan(0);
    expect(within(row as HTMLElement).getAllByText("6.50%").length).toBeGreaterThan(0);

    const yscvxRow = vaultRow(container, "yscvx");
    expect(yscvxRow).not.toBeNull();
    expect(within(yscvxRow as HTMLElement).getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(within(yscvxRow as HTMLElement).getAllByText("0.00%").length).toBeGreaterThan(0);
  });

  it("shows loading placeholders while the cache and ycvxcrv Yearn vault load", () => {
    setup({ cacheLoading: true, yearnLoading: { ycvxcrv: true } });

    expect(statValue("Total Value Locked")).toBe("...");
    expect(statValue("Avg APY")).toBe("...");
    expect(statValue("Vaults")).toBe(String(listedByDefault.length));
  });

  it("shows numbers when only the cache is still loading", () => {
    setup({ cacheLoading: true });

    expect(statValue("Total Value Locked")).toBe("$1.75M");
    expect(statValue("Avg APY")).toBe(`${averageDisplayApy(listedByDefault.map((v) => DEFAULT_APY[v.id as VaultId] ?? 0)).toFixed(1)}%`);
  });

  it("shows numbers when only the ycvxcrv Yearn vault is still loading", () => {
    setup({ yearnLoading: { ycvxcrv: true } });

    expect(statValue("Total Value Locked")).toBe("$1.75M");
    expect(statValue("Avg APY")).toBe(`${averageDisplayApy(listedByDefault.map((v) => DEFAULT_APY[v.id as VaultId] ?? 0)).toFixed(1)}%`);
  });
});

describe("HomePageContent vault list", () => {
  it("reports a vault count equal to the rendered rows", () => {
    const { container } = setup();

    expect(statValue("Vaults")).toBe(String(listedByDefault.length));
    expect(rowIds(container)).toHaveLength(listedByDefault.length);
  });

  it("hides a hidden-unless-holder vault without a balance", () => {
    expect(hiddenUnlessHolderVault).toBeDefined();
    const { container } = setup();

    expect(vaultRow(container, hiddenUnlessHolderVault?.id as string)).toBeNull();
  });

  it("shows a hidden-unless-holder vault when the user holds it", () => {
    expect(hiddenUnlessHolderVault).toBeDefined();
    const id = hiddenUnlessHolderVault?.id as VaultId;
    const { container } = setup({
      balances: {
        [id]: { balance: 1n, formattedUsd: "$1.00", usdValue: 1 },
      },
    });

    expect(vaultRow(container, id)).not.toBeNull();
    expect(rowIds(container)).toHaveLength(listedByDefault.length + 1);
    expect(statValue("Vaults")).toBe(String(listedByDefault.length + 1));
  });

  it("does not render a borrow or manage-loan control", () => {
    // yscvxcrv carries the "Collateral (LlamaLend)" badge and is listed by
    // default; ycvxcrv is the hidden-unless-holder vault.
    const { container } = setup({
      balances: {
        [hiddenUnlessHolderVault?.id as string]: {
          balance: 1n,
          formattedUsd: "$1.00",
          usdValue: 1,
        },
      },
    });

    expect(screen.queryByText(/^Borrow/)).toBeNull();
    expect(screen.queryByText("Manage loan")).toBeNull();
    expect(screen.queryByText("Loan")).toBeNull();
    expect(container.textContent).not.toContain("LlamaLend");
  });
});

describe("HomePageContent sorting", () => {
  const holdings: Record<string, number> = {
    ycvxcrv: 0,
    yscvxcrv: 100,
    yspxcvx: 0,
    yscvx: 50,
  };

  const holdingsBalances: Partial<Record<VaultId, BalanceSpec>> = {
    yscvxcrv: { balance: 1n, formattedUsd: "$100.00", usdValue: 100 },
    yscvx: { balance: 1n, formattedUsd: "$50.00", usdValue: 50 },
  };

  it("sorts by holdings by default", () => {
    const { container } = setup({ balances: holdingsBalances });

    expect(rowIds(container)).toEqual(expectedOrder(holdings));
  });

  it("starts from a stored apy sort", () => {
    const { container } = setup({ sortStoredValue: "apy" });

    expect(rowIds(container)).toEqual(expectedOrder(DEFAULT_APY));
    expect(rowIds(container)[0]).toBe(highestBy(DEFAULT_APY));
  });

  it("starts from a stored tvl sort", () => {
    const { container } = setup({ sortStoredValue: "tvl" });

    expect(rowIds(container)).toEqual(expectedOrder(DEFAULT_TVL));
    expect(rowIds(container)[0]).toBe(highestBy(DEFAULT_TVL));
  });

  it("falls back to holdings for an unknown stored value", () => {
    const { container } = setup({
      sortStoredValue: "bogus",
      balances: holdingsBalances,
    });

    expect(rowIds(container)).toEqual(expectedOrder(holdings));
  });

  it("re-sorts when TVL is chosen and stores the preference", () => {
    const { container } = setup({ sortStoredValue: "apy" });

    expect(rowIds(container)[0]).toBe(highestBy(DEFAULT_APY));

    const sortButton = screen.getByRole("button", { name: /Sort by/ });
    fireEvent.click(sortButton);
    fireEvent.click(
      within(sortButton.parentElement as HTMLElement).getByRole("button", {
        name: "TVL",
      }),
    );

    expect(rowIds(container)).toEqual(expectedOrder(DEFAULT_TVL));
    expect(localStorage.setItem).toHaveBeenCalledWith("yldfi-vault-sort", "tvl");
  });
});

describe("HomePageContent average APY", () => {
  it("averages the displayed APYs of the listed vaults", () => {
    setup();

    const expected = averageDisplayApy(
      listedByDefault.map((vault) => DEFAULT_APY[vault.id as VaultId] ?? 0),
    );
    expect(statValue("Avg APY")).toBe(`${expected.toFixed(1)}%`);
  });
});

describe("HomePageContent rewards badge", () => {
  const hiddenId = hiddenUnlessHolderVault?.id as VaultId;

  function yldReward(amount: string, price: number): MerklReward {
    const campaignId = [...getYldMerklCampaignIds(undefined)][0];
    return {
      root: "0x0000000000000000000000000000000000000000000000000000000000000000",
      distributionChainId: 1,
      amount,
      claimed: "0",
      pending: "0",
      proofs: [],
      recipient: "0x0000000000000000000000000000000000000001",
      token: {
        chainId: 1,
        address: "0x0000000000000000000000000000000000000002",
        decimals: 6,
        symbol: "USDC",
        price,
      },
      breakdowns: [
        {
          root: "0x0000000000000000000000000000000000000000000000000000000000000000",
          distributionChainId: 1,
          reason: "test",
          amount,
          claimed: "0",
          pending: "0",
          campaignId,
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

  const hiddenBalance: Partial<Record<VaultId, BalanceSpec>> = {
    [hiddenId]: { balance: 1n, formattedUsd: "$1.00", usdValue: 1 },
  };

  it("does not render a badge without an opportunity or earnings", () => {
    setup({ balances: hiddenBalance });

    expect(screen.queryByText(/% APR/)).toBeNull();
    expect(screen.queryByText(/Earning/)).toBeNull();
    expect(screen.queryByText("Rewards")).toBeNull();
  });

  it("shows earned rewards on the badge", () => {
    const { container } = setup({
      balances: hiddenBalance,
      merklRewards: [yldReward("2000000", 0.5)],
    });

    const row = vaultRow(container, hiddenId);
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getAllByText("Earning $1.00").length,
    ).toBeGreaterThan(0);
  });

  it("values a crvUSD reward without a price at $1", () => {
    const reward = yldReward("2000000", 0);
    reward.token = {
      ...reward.token,
      symbol: "crvUSD",
      price: undefined,
    };
    const { container } = setup({ balances: hiddenBalance, merklRewards: [reward] });

    const row = vaultRow(container, hiddenId);
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getAllByText("Earning $2.00").length,
    ).toBeGreaterThan(0);
  });

  it("counts only the priced reward when a non-crvUSD reward has no price", () => {
    const unpriced = yldReward("2000000", 0);
    unpriced.token = { ...unpriced.token, price: undefined };
    const { container } = setup({
      balances: hiddenBalance,
      merklRewards: [unpriced, yldReward("3000000", 0.5)],
    });

    const row = vaultRow(container, hiddenId);
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getAllByText("Earning $1.50").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("shows the live campaign APR when the rewards vault is not deprecated", async () => {
    // The only hasRewards vault is ycvxcrv, which the real config marks
    // deprecated (so the badge requires earnings and shows the earnings text).
    // The plan's APR scenario needs a listed, non-deprecated rewards vault, so
    // this case renders a fresh component with just that flag lifted.
    vi.resetModules();
    vi.doMock("@/config/vaults", async () => {
      const actual = await vi.importActual<typeof import("@/config/vaults")>(
        "@/config/vaults",
      );
      return {
        ...actual,
        VAULTS: {
          ...actual.VAULTS,
          ycvxcrv: { ...actual.VAULTS.ycvxcrv, deprecated: undefined },
        },
      };
    });

    try {
      const { HomePageContent: FreshHomePageContent } = await import(
        "@/components/HomePageContent"
      );
      installMocks({
        balances: hiddenBalance,
        merklOpportunities: [liveOpportunity],
      });
      const { container } = render(<FreshHomePageContent />);

      const row = vaultRow(container, hiddenId);
      expect(row).not.toBeNull();
      expect(
        within(row as HTMLElement).getAllByText("12.3% APR").length,
      ).toBeGreaterThan(0);
    } finally {
      vi.doUnmock("@/config/vaults");
      vi.resetModules();
    }
  });
});
