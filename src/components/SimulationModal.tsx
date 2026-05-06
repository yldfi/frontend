"use client";

import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { VAULTS } from "@/config/vaults";
import { CUSTOM_TOKENS } from "@/lib/enso";
import type { SimulationAssetChange } from "@/types/enso";

interface SimulationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  simulationResult: {
    success: boolean;
    gasUsed: number | null;
    errorMessage: string | { id?: string; slug?: string; message?: string } | null;
    tenderlyUrl: string | null;
    assetChanges: SimulationAssetChange[];
    simulationUnavailable?: boolean;
    simulationUnavailableReason?: string;
  };
  gasPrice?: bigint | null;
  ethPrice?: number | null;
  confirmText?: string;
  confirmDisabled?: boolean;
  summary?: { label: string; value: string; subValue?: string; subValueColor?: string }[];
  swapTitle?: string;
  borrowSwapTitle?: string;
  /** Per-swap price impacts override the single aggregate price impact */
  perSwapPriceImpacts?: { input?: number; output?: number };
  /**
   * Route-level price impact from the quote. When provided, this takes
   * precedence over the aggregate Tenderly USD value delta. Pass null when
   * the quote could not compute impact so the modal does not relabel value
   * delta as price impact.
   */
  routePriceImpact?: number | null;
  /** When true, groups borrow+deposit as leverage (crvUSD used to buy more collateral) */
  leverageMode?: boolean;
}

// Asset change row component
function AssetChangeRow({ change }: { change: SimulationAssetChange }) {
  // Get token logo from Tenderly, vault config, custom tokens, or fallback
  const customToken = change.address ? CUSTOM_TOKENS.find(t => t.address.toLowerCase() === change.address!.toLowerCase()) : undefined;
  const tokenLogo = change.logo
    || VAULTS[change.symbol.toLowerCase() as keyof typeof VAULTS]?.logo
    || customToken?.logoURI
    || (change.symbol === "ETH" ? "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png" : undefined)
    || (change.symbol.toLowerCase() === "crvusd" ? "/tokens/crvusd.png" : undefined);

  return (
    <div className="flex items-center gap-3 bg-[var(--muted)] rounded-lg p-3">
      {tokenLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={tokenLogo} alt={change.symbol} width={24} height={24} className="rounded-full shrink-0" />
      ) : (
        <div className="w-6 h-6 rounded-full bg-[var(--muted)] shrink-0" />
      )}
      <span className="mono text-sm flex-1">
        {Number(change.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {change.symbol}
      </span>
      <span className="text-sm text-[var(--muted-foreground)]">
        ~${change.dollarValue ? Number(change.dollarValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}
      </span>
    </div>
  );
}

// Asset changes section component
function AssetChangesSection({
  title,
  changes,
  type
}: {
  title: string;
  changes: SimulationAssetChange[];
  type: SimulationAssetChange["type"];
}) {
  // Filter by type and exclude zero/near-zero amounts (dust)
  const filtered = changes.filter(c => c.type === type && Math.abs(Number(c.amount)) > 0.000001);
  if (filtered.length === 0) return null;

  return (
    <div>
      <div className="text-xs text-[var(--muted-foreground)] mb-2">{title}</div>
      <div className="space-y-2">
        {filtered.map((change, i) => (
          <AssetChangeRow key={`${type}-${i}`} change={change} />
        ))}
      </div>
    </div>
  );
}

// Inline price impact display — pr-3 aligns with dollar values inside AssetChangeRow's p-3
function PriceImpactBadge({ impact }: { impact: number }) {
  return (
    <span className={cn(
      "text-xs mono ml-auto pr-3",
      impact <= 0 ? "text-green-500" : impact < 3 ? "text-yellow-500" : "text-red-500"
    )}>
      {impact > 0 ? "" : "+"}{(-impact).toFixed(2)}%
    </span>
  );
}

// Compute price impact from dollar values: ((inUsd - outUsd) / inUsd) * 100
function computeImpact(inChanges: SimulationAssetChange[], outChanges: SimulationAssetChange[]): number | null {
  const inUsd = inChanges.filter(c => c.dollarValue).reduce((sum, c) => sum + Number(c.dollarValue), 0);
  const outUsd = outChanges.filter(c => c.dollarValue).reduce((sum, c) => sum + Number(c.dollarValue), 0);
  if (inUsd > 0 && outUsd > 0) return ((inUsd - outUsd) / inUsd) * 100;
  return null;
}

// Compute price impact from token amounts — used for borrow&swap where one side is crvUSD.
// Dollar values are unreliable here: crvUSD trades below $1 but debt is at face value ($1).
function computeAmountImpact(inChanges: SimulationAssetChange[], outChanges: SimulationAssetChange[]): number | null {
  const inAmt = inChanges.reduce((sum, c) => sum + Math.abs(Number(c.amount)), 0);
  const outAmt = outChanges.reduce((sum, c) => sum + Math.abs(Number(c.amount)), 0);
  if (inAmt > 0 && outAmt > 0) return ((inAmt - outAmt) / inAmt) * 100;
  return null;
}

// Extract error message from string or object
function getErrorMessage(error: string | { id?: string; slug?: string; message?: string } | null): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message || error.slug || "Unknown error";
}

export function SimulationModal({
  isOpen,
  onClose,
  onConfirm,
  simulationResult,
  gasPrice,
  ethPrice,
  confirmText = "Confirm",
  confirmDisabled = false,
  summary,
  swapTitle = "You Swap",
  borrowSwapTitle,
  perSwapPriceImpacts,
  routePriceImpact,
  leverageMode = false,
}: SimulationModalProps) {
  if (!isOpen) return null;

  const errorMessage = getErrorMessage(simulationResult.errorMessage);

  const handleViewTrace = async () => {
    if (!simulationResult.tenderlyUrl) return;
    try {
      const res = await fetch(simulationResult.tenderlyUrl);
      const data = await res.json() as { url?: string };
      if (data.url) window.open(data.url, "_blank");
    } catch {
      window.open(simulationResult.tenderlyUrl, "_blank");
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-sm bg-[var(--background)] rounded-xl p-5 space-y-4 shadow-xl border border-[var(--border)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="font-medium">Simulation by</span>
            <a
              href="https://tenderly.co"
              target="_blank"
              rel="noopener noreferrer"
              className="opacity-90 hover:opacity-100 transition-opacity"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://storage.googleapis.com/tenderly-public-assets/tenderly-logo-purple.png"
                alt="Tenderly"
                className="h-8 -translate-x-[5px] translate-y-[1px]"
              />
            </a>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Success/Failure/Unavailable Status */}
        {simulationResult.simulationUnavailable ? (
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-yellow-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm font-medium text-yellow-500">Simulation Unavailable</span>
          </div>
        ) : simulationResult.success ? (
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium">Simulation Success</span>
            {simulationResult.tenderlyUrl && (
              <button
                onClick={handleViewTrace}
                className="text-xs text-[var(--foreground)] hover:text-[var(--accent)] flex items-center gap-1 ml-auto transition-colors"
              >
                View trace
                <ExternalLink size={10} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-[var(--destructive)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium text-[var(--destructive)]">Simulation Failed</span>
            {simulationResult.tenderlyUrl && (
              <button
                onClick={handleViewTrace}
                className="text-xs text-[var(--foreground)] hover:text-[var(--accent)] flex items-center gap-1 ml-auto transition-colors"
              >
                View trace
                <ExternalLink size={10} />
              </button>
            )}
          </div>
        )}

        {/* Simulation unavailable warning */}
        {simulationResult.simulationUnavailable && (
          <div className="text-sm text-yellow-500 bg-yellow-500/10 rounded-lg p-3 space-y-1">
            <p>Detailed simulation is temporarily unavailable. The transaction has been validated via eth_call and should succeed.</p>
            <p className="text-xs text-yellow-500/70">Reason: {simulationResult.simulationUnavailableReason || "Service unavailable"}</p>
          </div>
        )}

        {/* Error message */}
        {!simulationResult.success && !simulationResult.simulationUnavailable && errorMessage && (
          <div className="text-sm text-[var(--destructive)] bg-[var(--destructive)]/5 rounded-lg p-3">
            {errorMessage}
          </div>
        )}

        {/* Asset changes */}
        {simulationResult.success && simulationResult.assetChanges.length > 0 && (() => {
          // Deduplicate: if a token appears in both "send" and "deposit" (direct deposit, no swap),
          // hide the redundant "send" entry since "deposit" already conveys the action
          const deposits = simulationResult.assetChanges.filter(c => c.type === "deposit");
          const sends = simulationResult.assetChanges.filter(c => c.type === "send");
          const borrows = simulationResult.assetChanges.filter(c => c.type === "borrow");
          const receives = simulationResult.assetChanges.filter(c => c.type === "receive");
          const depositSymbols = new Set(deposits.map(c => c.symbol.toLowerCase()));
          const sendSymbols = new Set(sends.map(c => c.symbol.toLowerCase()));
          const borrowSymbols = new Set(borrows.map(c => c.symbol.toLowerCase()));
          const receiveSymbols = new Set(receives.map(c => c.symbol.toLowerCase()));

          // Detect input swap: "send" token differs from "deposit" token (e.g. yscvgCVX → ycvxCRV)
          const swapSends = sends.filter(c => !depositSymbols.has(c.symbol.toLowerCase()));
          const swapDeposits = deposits.filter(c => !sendSymbols.has(c.symbol.toLowerCase()));
          const hasSwapToDeposit = swapSends.length > 0 && swapDeposits.length > 0;

          // Detect output swap: "borrow" token differs from "receive" token (e.g. crvUSD → USDC)
          const hasBorrowSwap = borrowSwapTitle
            && borrows.length > 0 && receives.length > 0
            && !receives.some(c => borrowSymbols.has(c.symbol.toLowerCase()));

          const filteredChanges = simulationResult.assetChanges.filter(
            c => !(c.type === "send" && depositSymbols.has(c.symbol.toLowerCase()))
          );

          const SwapArrow = () => (
            <div className="flex justify-center text-[var(--muted-foreground)] py-0.5">
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 12.5a.5.5 0 0 1-.354-.146l-4-4a.5.5 0 0 1 .708-.708L8 11.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4A.5.5 0 0 1 8 12.5z" />
              </svg>
            </div>
          );

          // Compute per-swap price impacts from Tenderly USD values
          const inputSwapImpact = hasSwapToDeposit
            ? (perSwapPriceImpacts?.input ?? computeImpact(swapSends, swapDeposits))
            : null;
          const borrowSwapBorrows = borrows.filter(c => !receiveSymbols.has(c.symbol.toLowerCase()));
          const borrowSwapReceives = receives.filter(c => !borrowSymbols.has(c.symbol.toLowerCase()));
          // Use amount-based impact for borrow&swap (crvUSD debt is at face value, not market price)
          const outputSwapImpact = hasBorrowSwap
            ? (perSwapPriceImpacts?.output ?? computeAmountImpact(borrowSwapBorrows, borrowSwapReceives))
            : null;

          // Build action groups, then render with separators between them
          const groups: React.ReactNode[] = [];

          if (leverageMode && borrows.length > 0 && deposits.length > 0) {
            // --- Leverage mode ---
            // Split deposits into "from input swap" vs "from leverage borrow"
            // The leverage deposit's dollar value is closest to the borrow's dollar value
            const borrowDollar = borrows.reduce((sum, c) => sum + Number(c.dollarValue ?? 0), 0);
            const depositToken = deposits[0]; // all deposits are same token in leverage

            let inputDeposits: SimulationAssetChange[];
            let leverageDeposits: SimulationAssetChange[];

            if (deposits.length >= 2 && borrowDollar > 0) {
              // Find the deposit closest in dollar value to the borrow (that's the leverage one)
              const sorted = [...deposits].sort((a, b) => {
                const diffA = Math.abs(Number(a.dollarValue ?? 0) - borrowDollar);
                const diffB = Math.abs(Number(b.dollarValue ?? 0) - borrowDollar);
                return diffA - diffB;
              });
              leverageDeposits = [sorted[0]];
              inputDeposits = sorted.slice(1);
            } else if (deposits.length >= 2) {
              // No dollar values — assume smallest deposit is leverage
              const sorted = [...deposits].sort((a, b) => Number(a.amount) - Number(b.amount));
              leverageDeposits = [sorted[0]];
              inputDeposits = sorted.slice(1);
            } else {
              // Single deposit — all goes to input, leverage just shows borrow
              inputDeposits = deposits;
              leverageDeposits = [];
            }

            const inputDepositAmount = inputDeposits.reduce((sum, c) => sum + Number(c.amount), 0);
            const inputDepositDollar = inputDeposits.reduce((sum, c) => sum + Number(c.dollarValue ?? 0), 0);

            // Input group: user's token → collateral from input swap
            if (sends.length > 0) {
              groups.push(
                <div key="input-swap">
                  <div className="flex items-center text-xs text-[var(--muted-foreground)] mb-2">
                    Swap & Deposit as Collateral
                    {inputSwapImpact !== null && <PriceImpactBadge impact={inputSwapImpact} />}
                  </div>
                  <div className="space-y-1">
                    {sends.map((send, i) => (
                      <AssetChangeRow key={`swap-send-${i}`} change={send} />
                    ))}
                    <SwapArrow />
                    <AssetChangeRow change={{
                      ...depositToken,
                      amount: inputDepositAmount.toString(),
                      dollarValue: inputDepositDollar > 0 ? inputDepositDollar.toString() : undefined,
                    }} />
                  </div>
                </div>
              );
            } else {
              // No input swap — direct collateral deposit
              if (inputDeposits.length > 0) {
                groups.push(
                  <div key="deposit">
                    <div className="text-xs text-[var(--muted-foreground)] mb-2">You Deposit</div>
                    {inputDeposits.map((dep, i) => (
                      <AssetChangeRow key={`input-dep-${i}`} change={dep} />
                    ))}
                  </div>
                );
              }
            }

            // Leverage group: borrow crvUSD → swap to more collateral
            const filteredBorrows = borrows.filter(c => Math.abs(Number(c.amount)) > 0.000001);
            if (filteredBorrows.length > 0) {
              groups.push(
                <div key="leverage">
                  <div className="text-xs text-[var(--muted-foreground)] mb-2">Leverage</div>
                  <div className="space-y-1">
                    {filteredBorrows.map((b, i) => (
                      <AssetChangeRow key={`leverage-borrow-${i}`} change={b} />
                    ))}
                    {leverageDeposits.length > 0 && (
                      <>
                        <SwapArrow />
                        {leverageDeposits.map((dep, i) => (
                          <AssetChangeRow key={`leverage-dep-${i}`} change={dep} />
                        ))}
                      </>
                    )}
                  </div>
                </div>
              );
            }
          } else {
            // --- Standard mode ---

            // Input swap or standard send/deposit
            if (hasSwapToDeposit) {
              groups.push(
                <div key="input-swap">
                  <div className="flex items-center text-xs text-[var(--muted-foreground)] mb-2">
                    {swapTitle}
                    {inputSwapImpact !== null && <PriceImpactBadge impact={inputSwapImpact} />}
                  </div>
                  <div className="space-y-1">
                    {swapSends.map((send, i) => (
                      <AssetChangeRow key={`swap-send-${i}`} change={send} />
                    ))}
                    <SwapArrow />
                    {swapDeposits.map((dep, i) => (
                      <AssetChangeRow key={`swap-dep-${i}`} change={dep} />
                    ))}
                  </div>
                </div>
              );
            } else {
              const depSection = <AssetChangesSection key="deposit" title="You Deposit" changes={filteredChanges} type="deposit" />;
              const sendSection = <AssetChangesSection key="send" title="You Send" changes={filteredChanges} type="send" />;
              if (deposits.length > 0) groups.push(depSection);
              if (sends.length > 0) groups.push(sendSection);
            }

            // Output swap or standard borrow/receive
            if (hasBorrowSwap) {
              groups.push(
                <div key="output-swap">
                  <div className="flex items-center text-xs text-[var(--muted-foreground)] mb-2">
                    {borrowSwapTitle}
                    {outputSwapImpact !== null && <PriceImpactBadge impact={outputSwapImpact} />}
                  </div>
                  <div className="space-y-1">
                    {borrowSwapBorrows.map((b, i) => (
                      <AssetChangeRow key={`bswap-borrow-${i}`} change={b} />
                    ))}
                    <SwapArrow />
                    {borrowSwapReceives.map((r, i) => (
                      <AssetChangeRow key={`bswap-receive-${i}`} change={r} />
                    ))}
                  </div>
                </div>
              );
            } else {
              const borrowSection = <AssetChangesSection key="borrow" title="You Borrow" changes={filteredChanges} type="borrow" />;
              const receiveSection = <AssetChangesSection key="receive" title="You Receive" changes={filteredChanges} type="receive" />;
              if (borrows.length > 0) groups.push(borrowSection);
              if (receives.length > 0) groups.push(receiveSection);
            }
          }

          // Repay
          const repaySection = <AssetChangesSection key="repay" title="You Repay" changes={filteredChanges} type="repay" />;
          const hasRepay = filteredChanges.some(c => c.type === "repay" && Math.abs(Number(c.amount)) > 0.000001);
          if (hasRepay) groups.push(repaySection);

          return (
            <div className="space-y-3">
              {groups.map((group, i) => (
                <div key={i}>
                  {i > 0 && <div className="border-t border-[var(--border)] mb-3" />}
                  {group}
                </div>
              ))}
            </div>
          );
        })()}

        {/* No asset changes fallback */}
        {simulationResult.success && simulationResult.assetChanges.length === 0 && (
          <div className="text-sm text-[var(--muted-foreground)] text-center py-4">
            No asset changes detected
          </div>
        )}

        {/* Summary info (collateral changes, position totals, etc.) */}
        {simulationResult.success && summary && summary.length > 0 && (
          <div className="border-t border-[var(--border)] pt-3 space-y-1">
            {summary.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-[var(--muted-foreground)]">{item.label}</span>
                <div className="text-right">
                  {item.subValue && (
                    <span className="mr-1" style={item.subValueColor ? { color: item.subValueColor } : undefined}>({item.subValue})</span>
                  )}
                  <span className="mono">{item.value}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Gas estimate with ETH and USD cost */}
        {simulationResult.gasUsed && (
          <div className="border-t border-[var(--border)] pt-3 space-y-1">
            {/* Aggregate price impact — hidden when per-swap impacts are shown inline */}
            {!perSwapPriceImpacts && (() => {
              if (routePriceImpact !== undefined) {
                if (routePriceImpact === null) return null;
                return (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">Price Impact</span>
                    <span className={cn(
                      "mono",
                      routePriceImpact < 0 ? "text-green-500"
                        : routePriceImpact > 2 ? "text-red-500"
                        : routePriceImpact > 1 ? "text-yellow-500"
                        : ""
                    )}>
                      {routePriceImpact.toFixed(2)}%
                    </span>
                  </div>
                );
              }

              // Skip price impact if all sent tokens also appear as deposits (direct deposit, no swap)
              const sends = simulationResult.assetChanges.filter(c => c.type === "send");
              const depositSymbols = new Set(
                simulationResult.assetChanges
                  .filter(c => c.type === "deposit")
                  .map(c => c.symbol.toLowerCase())
              );
              const hasSwap = sends.some(c => !depositSymbols.has(c.symbol.toLowerCase()));
              if (!hasSwap) return null;

              const sendUsd = sends
                .filter(c => c.dollarValue)
                .reduce((sum, c) => sum + Number(c.dollarValue), 0);
              const outUsd = simulationResult.assetChanges
                .filter(c => (c.type === "receive" || c.type === "deposit") && c.dollarValue)
                .reduce((sum, c) => sum + Number(c.dollarValue), 0);
              if (sendUsd > 0 && outUsd > 0) {
                const impact = ((sendUsd - outUsd) / sendUsd) * 100;
                return (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">Price Impact</span>
                    <span className={cn(
                      "mono",
                      impact <= 0 ? "text-green-500"
                        : impact < 3 ? "text-yellow-500"
                        : "text-red-500"
                    )}>
                      {impact > 0 ? "" : "+"}{(-impact).toFixed(2)}%
                    </span>
                  </div>
                );
              }
              return null;
            })()}
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--muted-foreground)]">Est. Gas</span>
              <span className="mono">{simulationResult.gasUsed.toLocaleString()}</span>
            </div>
            {gasPrice && (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Cost (ETH)</span>
                  <span className="mono">
                    {(Number(simulationResult.gasUsed) * Number(gasPrice) / 1e18).toFixed(6)} ETH
                  </span>
                </div>
                {ethPrice && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">Cost (USD)</span>
                    <span className="mono">
                      ${(Number(simulationResult.gasUsed) * Number(gasPrice) / 1e18 * ethPrice).toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Gas Price</span>
                  <span className="mono">
                    {(Number(gasPrice) / 1e9).toFixed(2)} gwei
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-lg font-medium transition-all bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--muted)]/80"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!simulationResult.success || confirmDisabled}
            className={cn(
              "flex-1 py-3 rounded-lg font-medium transition-all",
              simulationResult.success && !confirmDisabled
                ? "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer"
                : "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed opacity-50"
            )}
          >
            {simulationResult.success ? confirmText : "Cannot Execute"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
