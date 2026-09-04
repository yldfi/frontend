"use client";

import { useQuery } from "@tanstack/react-query";
import { useBalance, usePublicClient } from "wagmi";
import { useAccount } from "wagmi";
import { useCallback, useMemo } from "react";
import { fetchWalletBalances, fetchTokenPrices, ETH_ADDRESS } from "@/lib/enso";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { VAULTS } from "@/config/vaults";
import { useVaultCache, type VaultCacheResponse } from "@/hooks/useVaultCache";
import type { EnsoToken } from "@/types/enso";
import { erc20Abi } from "viem";

interface WalletTokenCandidate {
  token: string;
  amount: string;
  decimals: number;
  price: number;
  name?: string;
  symbol?: string;
}

const SPAM_TOKEN_TEXT_PATTERN =
  /\b(claim|reward|rewards|bonus|airdrop|gift|urgent|visit|secure your funds)\b|https?:\/\/|www\.|\.com|\.org|\.xyz|\.site/i;

export function shouldAutoIncludeWalletToken(
  token: WalletTokenCandidate,
  allowlist?: ReadonlySet<string>,
): boolean {
  const address = token.token.toLowerCase();
  if (!allowlist?.has(address)) return false;
  if (!Number.isFinite(token.price) || token.price <= 0) return false;

  try {
    if (BigInt(token.amount) <= 0n) return false;
  } catch {
    return false;
  }

  const displayText = `${token.name ?? ""} ${token.symbol ?? ""}`;
  return !SPAM_TOKEN_TEXT_PATTERN.test(displayText);
}

export function applyVaultSharePrices(
  prices: Map<string, number>,
  vaultCache?: VaultCacheResponse,
): void {
  if (!vaultCache) return;

  const cachedUnderlyingPrices = new Map<string, number>([
    ["cvx", vaultCache.cvxPrice],
    ["cvxcrv", vaultCache.cvxCrvPrice],
    ["cvgcvx", vaultCache.cvgCvxPrice],
    ["pxcvx", vaultCache.pxCvxPrice],
  ]);

  for (const vault of Object.values(VAULTS)) {
    const cacheEntry = vaultCache[vault.id as keyof VaultCacheResponse];
    if (!cacheEntry || typeof cacheEntry !== "object" || !("pps" in cacheEntry)) continue;

    const underlyingPrice =
      prices.get(vault.assetAddress.toLowerCase()) ??
      cachedUnderlyingPrices.get(vault.assetSymbol.toLowerCase());
    if (!underlyingPrice || underlyingPrice <= 0 || cacheEntry.pps <= 0) continue;

    prices.set(vault.address.toLowerCase(), cacheEntry.pps * underlyingPrice);
  }
}

/**
 * Fetch wallet balances and return sorted tokens.
 * - Mainnet: Enso API (efficient, includes prices)
 * - Test networks (Anvil/Tenderly): on-chain multicall balanceOf
 */
interface UseTokenBalancesOptions {
  /**
   * Read the requested token balances on-chain even on mainnet. This is useful
   * for selected-input balances that must update immediately after a tx receipt,
   * while the broader token selector can still use Enso's indexed wallet list.
   */
  preferOnchain?: boolean;
  /**
   * Include priced wallet-balance tokens returned by Enso even when they are
   * not present in the provided token list. This keeps the selector from
   * hiding wallet assets simply because the token-list query did not include
   * them in the currently visible slice.
   */
  includeWalletTokens?: boolean;
  /**
   * Optional allowlist for wallet-balance tokens that are not already in the
   * visible token list. This prevents dust/scam airdrops from being auto-added
   * just because a balance API reports them with a nonzero price.
   */
  walletTokenAllowlist?: readonly string[];
}

export function useTokenBalances(tokens: EnsoToken[], options: UseTokenBalancesOptions = {}) {
  const { address: userAddress, isConnected } = useAccount();
  const { isTestNetwork } = useTestNetwork();
  const { data: vaultCache } = useVaultCache();
  const publicClient = usePublicClient();
  const shouldFetchOnchain = isTestNetwork || options.preferOnchain;
  const walletTokenAllowlist = useMemo(
    () => options.walletTokenAllowlist
      ? new Set(options.walletTokenAllowlist.map((address) => address.toLowerCase()))
      : undefined,
    [options.walletTokenAllowlist],
  );

  // Get ETH balance separately (Enso may not include native ETH)
  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({
    address: userAddress,
    query: {
      enabled: isConnected,
    },
  });

  // --- Mainnet path: Enso API ---
  const {
    data: ensoBalances,
    isLoading: ensoBalancesLoading,
    refetch: refetchEnsoBalances,
  } = useQuery({
    queryKey: ["enso-wallet-balances", userAddress],
    queryFn: () => fetchWalletBalances(userAddress!),
    enabled: !!userAddress && isConnected && !isTestNetwork,
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    retry: false,
  });

  // --- Test network path: on-chain multicall ---
  const erc20Addresses = useMemo(() => {
    return tokens
      .filter((t) => t.address.toLowerCase() !== ETH_ADDRESS.toLowerCase())
      .map((t) => t.address as `0x${string}`);
  }, [tokens]);

  const erc20BalanceKey = useMemo(
    () => erc20Addresses.map((address) => address.toLowerCase()),
    [erc20Addresses],
  );

  const {
    data: onchainBalances,
    isLoading: onchainLoading,
    refetch: refetchOnchainBalances,
  } = useQuery({
    queryKey: ["onchain-balances", userAddress, erc20BalanceKey],
    queryFn: async () => {
      if (!publicClient || !userAddress) return [];

      const calls = erc20Addresses.map((addr) => ({
        address: addr,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [userAddress] as const,
      }));

      const results = await publicClient.multicall({ contracts: calls });

      return erc20Addresses.map((addr, i) => ({
        address: addr.toLowerCase(),
        balance: (results[i].status === "success" ? results[i].result : 0n) as bigint,
      }));
    },
    enabled: !!userAddress && isConnected && shouldFetchOnchain && !!publicClient,
    staleTime: options.preferOnchain ? 0 : 10 * 1000,
    refetchInterval: isTestNetwork ? 15 * 1000 : false,
  });

  // Prices (from Enso — works for both paths, prices are mainnet-based anyway)
  const tokenPriceAddresses = useMemo(() => {
    const addresses = new Map<string, string>();
    for (const token of tokens.slice(0, 20)) {
      addresses.set(token.address.toLowerCase(), token.address);
    }
    for (const item of ensoBalances ?? []) {
      try {
        if (BigInt(item.amount) > 0n) addresses.set(item.token.toLowerCase(), item.token);
      } catch {
        // Ignore malformed upstream balances.
      }
    }
    for (const item of onchainBalances ?? []) {
      if (item.balance > 0n) addresses.set(item.address.toLowerCase(), item.address);
    }
    return Array.from(addresses.values());
  }, [ensoBalances, onchainBalances, tokens]);

  const { data: tokenPrices, isLoading: pricesLoading } = useQuery({
    queryKey: ["enso-token-prices", tokenPriceAddresses],
    queryFn: () => fetchTokenPrices(tokenPriceAddresses),
    enabled: tokenPriceAddresses.length > 0,
    staleTime: 2 * 60 * 1000,
    retry: false,
  });

  // Build balance and price maps, sort tokens
  const { balanceMap, priceMap, sortedTokens } = useMemo(() => {
    const balances = new Map<string, bigint>();
    const prices = new Map<string, number>();
    const tokenMap = new Map<string, EnsoToken>();

    for (const token of tokens) {
      tokenMap.set(token.address.toLowerCase(), token);
    }

    // Add ETH balance
    if (ethBalance) {
      balances.set(ETH_ADDRESS.toLowerCase(), ethBalance.value);
    }

    // Add prices from batch price fetch
    if (tokenPrices) {
      for (const item of tokenPrices) {
        prices.set(item.address.toLowerCase(), item.price);
      }
    }

    if (!isTestNetwork) {
      // Mainnet: use Enso balances for the broad wallet list and price data.
      if (ensoBalances) {
        for (const item of ensoBalances) {
          const address = item.token.toLowerCase();
          balances.set(address, BigInt(item.amount));
          if (item.price > 0) {
            prices.set(address, item.price);
          }
          if (
            options.includeWalletTokens &&
            !tokenMap.has(address) &&
            shouldAutoIncludeWalletToken(item, walletTokenAllowlist)
          ) {
            tokenMap.set(address, {
              address: item.token,
              chainId: item.chainId,
              name: item.name || item.symbol || "Unknown",
              symbol: item.symbol || "???",
              decimals: item.decimals,
              logoURI: item.logoUri,
              type: "base",
            });
          }
        }
      }
    }

    // Enso does not consistently price custom ERC-4626 share tokens. Use the
    // same PPS and underlying-price cache as the vault pages for yld shares.
    applyVaultSharePrices(prices, vaultCache);

    // On-chain reads override Enso for requested tokens when enabled. This
    // keeps selected-token balances fresh immediately after tx receipts.
    if (shouldFetchOnchain && onchainBalances) {
      for (const item of onchainBalances) {
        balances.set(item.address, item.balance);
      }
    }

    // Sort tokens: those with balance first, then by original order
    const sorted = Array.from(tokenMap.values()).sort((a, b) => {
      const balanceA = balances.get(a.address.toLowerCase()) ?? 0n;
      const balanceB = balances.get(b.address.toLowerCase()) ?? 0n;

      if ((balanceA > 0n) === (balanceB > 0n)) return 0;
      return balanceB > 0n ? 1 : -1;
    });

    return { balanceMap: balances, priceMap: prices, sortedTokens: sorted };
  }, [
    tokens,
    ensoBalances,
    onchainBalances,
    ethBalance,
    tokenPrices,
    vaultCache,
    isTestNetwork,
    shouldFetchOnchain,
    options.includeWalletTokens,
    walletTokenAllowlist,
  ]);

  const refetch = useCallback(() => {
    void refetchEthBalance();
    void refetchEnsoBalances();
    void refetchOnchainBalances();
  }, [refetchEnsoBalances, refetchEthBalance, refetchOnchainBalances]);

  const refetchOnchain = useCallback(() => {
    void refetchEthBalance();
    void refetchOnchainBalances();
  }, [refetchEthBalance, refetchOnchainBalances]);

  return {
    sortedTokens,
    balanceMap,
    priceMap,
    refetch,
    refetchOnchain,
    isLoading: isTestNetwork
      ? onchainLoading || pricesLoading
      : ensoBalancesLoading || (options.preferOnchain && onchainLoading) || pricesLoading,
  };
}
