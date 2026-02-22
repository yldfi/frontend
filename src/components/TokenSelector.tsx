"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useEnsoTokens } from "@/hooks/useEnsoTokens";
import { useTokenMetadata } from "@/hooks/useTokenMetadata";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { formatUnits, isAddress } from "viem";
import { cn } from "@/lib/utils";
import { VAULTS, CURVE_SAVINGS } from "@/config/vaults";
import type { EnsoToken } from "@/types/enso";

// Our vault tokens to show in yld Vaults tab
const FEATURED_VAULT_TOKENS: EnsoToken[] = Object.values(VAULTS)
  .filter((v) => v.address !== "0x0000000000000000000000000000000000000000" && !v.hidden)
  .map((v) => ({
    address: v.address,
    name: v.name,
    symbol: v.symbol,
    decimals: v.decimals,
    logoURI: v.logoSmall,
    chainId: 1,
    type: "defi" as const,
  }));

// Tokens that should always be selectable regardless of excludeDefiTokens
// (our vaults + partner vaults we deeply integrate with)
const ALWAYS_AVAILABLE_ADDRESSES = new Set([
  ...FEATURED_VAULT_TOKENS.map((t) => t.address.toLowerCase()),
  CURVE_SAVINGS.SCRVUSD.toLowerCase(),
]);

interface TokenSelectorProps {
  selectedToken: EnsoToken | null;
  onSelect: (token: EnsoToken) => void;
  disabled?: boolean;
  excludeTokens?: string[]; // Addresses to exclude from list
  excludeDefiTokens?: boolean; // Exclude vault/strategy tokens (can't be swapped to)
  priorityTokens?: EnsoToken[]; // Tokens to show at top of list regardless of balance
}

// Token logo with fallback
function TokenLogo({
  token,
  size = 24,
}: {
  token: EnsoToken;
  size?: number;
}) {
  const [error, setError] = useState(false);

  const symbol = token?.symbol || "??";

  if (error || !token?.logoURI) {
    return (
      <div
        className="rounded-full bg-[var(--muted)] flex items-center justify-center text-xs font-medium"
        style={{ width: size, height: size }}
      >
        {symbol.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={token.logoURI}
      alt={symbol}
      width={size}
      height={size}
      className="rounded-full"
      onError={() => setError(true)}
    />
  );
}

// Token row with balance and USD value
function TokenRow({
  token,
  onSelect,
  isSelected,
  balance,
  price,
}: {
  token: EnsoToken;
  onSelect: () => void;
  isSelected: boolean;
  balance?: bigint;
  price?: number;
}) {
  // Format balance
  const balanceNum = balance
    ? Number(formatUnits(balance, token?.decimals || 18))
    : 0;
  const formattedBalance = balanceNum > 0 ? balanceNum.toFixed(4) : "0";

  // Calculate USD value
  const usdValue = balanceNum > 0 && price ? balanceNum * price : 0;
  const formattedUsd = usdValue > 0
    ? usdValue < 0.01
      ? "<$0.01"
      : `$${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";

  const symbol = token?.symbol || "??";
  const name = token?.name || "Unknown";

  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 p-3 hover:bg-[var(--muted)] transition-colors text-left",
        isSelected && "bg-[var(--muted)]"
      )}
    >
      <TokenLogo token={token} size={32} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{symbol}</span>
        </div>
        <span className="text-xs text-[var(--muted-foreground)] truncate block">
          {name}
        </span>
      </div>
      <div className="text-right">
        <div className="mono text-sm">{formattedBalance}</div>
        {formattedUsd && (
          <div className="mono text-xs text-[var(--muted-foreground)]">{formattedUsd}</div>
        )}
      </div>
    </button>
  );
}

export function TokenSelector({
  selectedToken,
  onSelect,
  disabled,
  excludeTokens,
  excludeDefiTokens,
  priorityTokens,
}: TokenSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"tokens" | "vaults">("tokens");
  const [confirmImportToken, setConfirmImportToken] = useState<EnsoToken | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const { tokens, searchQuery, setSearchQuery, isLoading, importToken } = useEnsoTokens();

  // Check if search query is an address and fetch metadata if so
  const isSearchAddress = isAddress(searchQuery);
  const { token: importedToken, isLoading: importLoading } = useTokenMetadata(
    isSearchAddress ? searchQuery : undefined
  );

  // Check if the imported token is already in the list
  const isImportedTokenInList = importedToken && tokens.some(
    (t) => t.address.toLowerCase() === importedToken.address.toLowerCase()
  );

  // Filter out excluded tokens and optionally DeFi tokens
  const excludeSet = useMemo(() => new Set((excludeTokens || []).map(addr => addr.toLowerCase())), [excludeTokens]);
  const filteredTokens = tokens.filter((t) => {
    // Exclude specific token addresses
    if (excludeSet.has(t.address.toLowerCase())) {
      return false;
    }
    // Exclude DeFi tokens (vault/strategy tokens can't be swapped to)
    // But always keep our vaults and partner tokens (scrvUSD etc.)
    if (excludeDefiTokens && t.type === "defi" && !ALWAYS_AVAILABLE_ADDRESSES.has(t.address.toLowerCase())) {
      return false;
    }
    return true;
  });

  // Merge priority tokens + vault tokens into the list for balance fetching (they may not be in filteredTokens)
  const tokensForBalances = useMemo(() => {
    const seen = new Set(filteredTokens.map(t => t.address.toLowerCase()));
    const extra = [
      ...(priorityTokens || []),
      ...FEATURED_VAULT_TOKENS,
    ].filter(t => !seen.has(t.address.toLowerCase()) && !excludeSet.has(t.address.toLowerCase()));
    // Deduplicate extras
    const extraSeen = new Set<string>();
    const uniqueExtra = extra.filter(t => {
      const key = t.address.toLowerCase();
      if (extraSeen.has(key)) return false;
      extraSeen.add(key);
      return true;
    });
    return uniqueExtra.length > 0 ? [...filteredTokens, ...uniqueExtra] : filteredTokens;
  }, [filteredTokens, priorityTokens, excludeSet]);

  // Sort tokens by balance (tokens with balance first), get prices
  const { sortedTokens, balanceMap, priceMap } = useTokenBalances(tokensForBalances);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modalRef.current &&
        !modalRef.current.contains(e.target as Node) &&
        !buttonRef.current?.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key — import dialog takes priority over main modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmImportToken) {
          setConfirmImportToken(null);
        } else {
          setIsOpen(false);
        }
      }
    };

    if (isOpen || confirmImportToken) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, confirmImportToken]);

  const handleSelect = (token: EnsoToken, shouldImport = false) => {
    if (shouldImport) {
      importToken(token); // Persist to localStorage
    }
    onSelect(token);
    setIsOpen(false);
    setSearchQuery("");
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => !disabled && setIsOpen(true)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-1.5 px-2 h-6 min-w-[72px] rounded-md border border-[var(--border)]",
          "hover:border-[var(--border-hover)] transition-colors",
          "bg-[var(--muted)]",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        {selectedToken ? (
          <>
            <TokenLogo token={selectedToken} size={16} />
            <span className="mono text-sm font-medium">{selectedToken.symbol}</span>
          </>
        ) : (
          <span className="text-sm text-[var(--muted-foreground)]">Select</span>
        )}
        <svg
          className="w-3 h-3 text-[var(--muted-foreground)]"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Import confirmation dialog */}
      {confirmImportToken &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setConfirmImportToken(null)}
            />
            <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-sm p-5 shadow-xl">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <h3 className="font-medium text-base">Import token?</h3>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--muted)] mb-3">
                <TokenLogo token={confirmImportToken} size={32} />
                <div className="min-w-0">
                  <div className="font-medium">{confirmImportToken.symbol}</div>
                  <div className="text-xs text-[var(--muted-foreground)] truncate">{confirmImportToken.name}</div>
                </div>
              </div>
              <p className="text-sm text-[var(--muted-foreground)] mb-1">
                <span className="mono text-xs break-all">{confirmImportToken.address}</span>
              </p>
              <p className="text-sm text-[var(--muted-foreground)] mb-4">
                This token isn&apos;t on the default token list. Make sure you&apos;ve verified the contract address before importing.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmImportToken(null)}
                  className="flex-1 py-2.5 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--muted)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    handleSelect(confirmImportToken, true);
                    setConfirmImportToken(null);
                  }}
                  className="flex-1 py-2.5 rounded-lg bg-[var(--foreground)] text-[var(--background)] text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  Import
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {isOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setIsOpen(false)}
            />
            <div
              ref={modalRef}
              className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-md max-h-[70vh] flex flex-col shadow-xl"
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
                <h3 className="font-medium">Select a token</h3>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
                  aria-label="Close token selector"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-[var(--border)]">
                <button
                  onClick={() => setActiveTab("tokens")}
                  className={cn(
                    "flex-1 py-3 text-sm font-medium transition-colors",
                    activeTab === "tokens"
                      ? "text-[var(--foreground)] border-b-2 border-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  Tokens
                </button>
                <button
                  onClick={() => setActiveTab("vaults")}
                  className={cn(
                    "flex-1 py-3 text-sm font-medium transition-colors",
                    activeTab === "vaults"
                      ? "text-[var(--foreground)] border-b-2 border-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  )}
                >
                  yld Vaults
                </button>
              </div>

              {/* Search (only for tokens tab) */}
              {activeTab === "tokens" && (
                <div className="p-4 border-b border-[var(--border)]">
                  <div className="relative">
                    <svg
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by name or address"
                      className="w-full bg-[var(--muted)] rounded-lg pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)]"
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* Token list */}
              <div className="flex-1 overflow-y-auto">
                {activeTab === "vaults" ? (
                  /* Vaults tab */
                  FEATURED_VAULT_TOKENS.filter(
                    (t) => !excludeSet.has(t.address.toLowerCase())
                  ).length === 0 ? (
                    <div className="text-center py-8 text-[var(--muted-foreground)]">
                      No vaults available
                    </div>
                  ) : (
                    FEATURED_VAULT_TOKENS
                      .filter((t) => !excludeSet.has(t.address.toLowerCase()))
                      .map((token) => (
                        <TokenRow
                          key={token.address}
                          token={token}
                          onSelect={() => handleSelect(token)}
                          isSelected={
                            selectedToken?.address?.toLowerCase() ===
                            token.address?.toLowerCase()
                          }
                          balance={balanceMap.get(token.address.toLowerCase())}
                          price={priceMap.get(token.address.toLowerCase())}
                        />
                      ))
                  )
                ) : isLoading ? (
                  /* Tokens tab - loading */
                  <div className="flex items-center justify-center py-8">
                    <svg
                      className="animate-spin h-5 w-5 text-[var(--muted-foreground)]"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  </div>
                ) : (
                  /* Tokens tab - loaded */
                  <>
                    {/* Show imported token option when user pastes an address */}
                    {isSearchAddress && !isImportedTokenInList && (
                      <div className="border-b border-[var(--border)]">
                        {importLoading ? (
                          <div className="flex items-center gap-3 p-3 text-[var(--muted-foreground)]">
                            <svg
                              className="animate-spin h-5 w-5"
                              xmlns="http://www.w3.org/2000/svg"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            <span className="text-sm">Loading token...</span>
                          </div>
                        ) : importedToken ? (
                          <div>
                            <div className="px-3 py-2 text-xs text-[var(--muted-foreground)] uppercase tracking-wider">
                              Import Token
                            </div>
                            <TokenRow
                              token={importedToken}
                              onSelect={() => setConfirmImportToken(importedToken)}
                              isSelected={false}
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-3 p-3 text-[var(--muted-foreground)]">
                            <span className="text-sm">No token found at this address</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Priority tokens (shown first, regardless of balance; filtered by search when searching) */}
                    {priorityTokens && priorityTokens.length > 0 && (() => {
                      const query = searchQuery.toLowerCase();
                      const visible = priorityTokens.filter((t) => {
                        if (excludeSet.has(t.address.toLowerCase())) return false;
                        if (!query) return true;
                        return (
                          t.symbol.toLowerCase().includes(query) ||
                          t.name.toLowerCase().includes(query) ||
                          t.address.toLowerCase() === query
                        );
                      });
                      if (visible.length === 0) return null;
                      return (
                        <>
                          {visible.map((token) => (
                            <TokenRow
                              key={`priority-${token.address}`}
                              token={token}
                              onSelect={() => handleSelect(token)}
                              isSelected={
                                selectedToken?.address?.toLowerCase() ===
                                token.address?.toLowerCase()
                              }
                              balance={balanceMap.get(token.address.toLowerCase())}
                              price={priceMap.get(token.address.toLowerCase())}
                            />
                          ))}
                          {/* Divider after priority tokens */}
                          <div className="border-b border-[var(--border)] mx-3" />
                        </>
                      );
                    })()}

                    {/* Regular token list */}
                    {sortedTokens.length === 0 && !isSearchAddress ? (
                      <div className="text-center py-8 text-[var(--muted-foreground)]">
                        No tokens found
                      </div>
                    ) : (
                      sortedTokens
                        .filter((token) => {
                          if (!token || !token.address || !token.symbol) return false;
                          // Exclude priority tokens from regular list to avoid duplicates
                          if (priorityTokens?.some(p => p.address.toLowerCase() === token.address.toLowerCase())) {
                            return false;
                          }
                          return true;
                        })
                        .map((token) => (
                          <TokenRow
                            key={token.address}
                            token={token}
                            onSelect={() => handleSelect(token)}
                            isSelected={
                              selectedToken?.address?.toLowerCase() ===
                              token.address?.toLowerCase()
                            }
                            balance={balanceMap.get(token.address.toLowerCase())}
                            price={priceMap.get(token.address.toLowerCase())}
                          />
                        ))
                    )}
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
