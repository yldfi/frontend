/**
 * Shared query cache configuration for consistent caching across hooks
 */

// Cache durations in milliseconds
export const CACHE_TIMES = {
  // Real-time data (balances, prices) - refresh frequently
  REALTIME: {
    staleTime: 0, // Always consider stale
    refetchInterval: 12_000, // ~1 Ethereum block
    gcTime: 60_000, // Keep in memory for 1 minute
  },
  // Semi-real-time data (vault APYs, TVL) - refresh every minute
  SEMI_REALTIME: {
    staleTime: 60_000, // 1 minute
    refetchInterval: 60_000, // 1 minute
    gcTime: 5 * 60_000, // Keep in memory for 5 minutes
  },
  // Static data (token lists, ABIs) - refresh rarely
  STATIC: {
    staleTime: 30 * 60_000, // 30 minutes
    refetchInterval: false as const, // Don't auto-refetch
    gcTime: 60 * 60_000, // Keep in memory for 1 hour
  },
} as const;

// Shorthand access for common use cases
export const QUERY_CONFIG = {
  // For user balances, allowances - needs frequent updates
  balance: CACHE_TIMES.REALTIME,
  // For vault data, APYs, TVL - updates every minute
  vaultData: CACHE_TIMES.SEMI_REALTIME,
  // For token lists, metadata - rarely changes
  tokenList: CACHE_TIMES.STATIC,
} as const;
