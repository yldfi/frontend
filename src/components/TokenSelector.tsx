"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useEnsoTokens } from "@/hooks/useEnsoTokens";
import { useTokenMetadata } from "@/hooks/useTokenMetadata";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { formatUnits, isAddress } from "viem";
import { cn } from "@/lib/utils";
import type { EnsoToken } from "@/types/enso";

interface TokenSelectorProps {
  selectedToken: EnsoToken | null;
  onSelect: (token: EnsoToken) => void;
  disabled?: boolean;
  excludeTokens?: string[]; // Addresses to exclude from list
  excludeDefiTokens?: boolean; // Exclude vault/strategy tokens (can't be swapped to)
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
}: TokenSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
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
  const excludeSet = new Set((excludeTokens || []).map(addr => addr.toLowerCase()));
  const filteredTokens = tokens.filter((t) => {
    // Exclude specific token addresses
    if (excludeSet.has(t.address.toLowerCase())) {
      return false;
    }
    // Exclude DeFi tokens (vault/strategy tokens can't be swapped to)
    if (excludeDefiTokens && t.type === "defi") {
      return false;
    }
    return true;
  });

  // Sort tokens by balance (tokens with balance first), get prices
  const { sortedTokens, balanceMap, priceMap } = useTokenBalances(filteredTokens);

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

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

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
          "flex items-center gap-1.5 px-2 h-6 rounded-md border border-[var(--border)]",
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
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
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

              {/* Search */}
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

              {/* Token list */}
              <div className="flex-1 overflow-y-auto">
                {isLoading ? (
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
                              onSelect={() => handleSelect(importedToken)}
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

                    {/* Regular token list */}
                    {sortedTokens.length === 0 && !isSearchAddress ? (
                      <div className="text-center py-8 text-[var(--muted-foreground)]">
                        No tokens found
                      </div>
                    ) : (
                      sortedTokens
                        .filter((token) => token && token.address && token.symbol)
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
