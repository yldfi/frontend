"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Loader2, ChevronRight, ChevronDown } from "lucide-react";
import type { ContractData } from "@/types/explorer";
import {
  readAllViewValues,
  extractAddresses,
  isContract,
  getGnosisSafeInfo,
  formatValue,
  type GnosisSafeInfo,
} from "@/lib/explorer/contractReader";
import {
  getContractName,
  isValidAddress,
  isZeroAddress,
  getContractNatSpec,
  type NatSpec,
} from "@/lib/explorer/etherscan";
import { useContractReaderClient } from "@/hooks/useContractReaderClient";

// Cache for pre-fetched contract names and EOA detection
const prefetchedNames = new Map<string, string | null>();
const knownEOAs = new Set<string>();

// Empty set singleton to avoid recreating on every render
const EMPTY_SET = new Set<string>();

interface ContractViewProps {
  address: string;
  sourceName?: string;
  depth?: number;
  maxDepth?: number;
  visitedAddresses?: Set<string>;
  defaultCollapsed?: boolean;
}

export function ContractView({
  address,
  sourceName,
  depth = 0,
  maxDepth = 3,
  visitedAddresses,
  defaultCollapsed = false,
}: ContractViewProps) {
  // Sync wagmi public client with contract reader (only at root level)
  useContractReaderClient();

  // Use stable reference for visitedAddresses
  const stableVisitedAddresses = visitedAddresses ?? EMPTY_SET;

  const [contractData, setContractData] = useState<ContractData>({
    address,
    values: [],
    isLoading: true,
  });
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set());
  const [isCollapsed, setIsCollapsed] = useState(depth > 0 ? (defaultCollapsed ?? true) : false);
  const [showRawValues, setShowRawValues] = useState<Set<string>>(new Set());
  const [natspec, setNatspec] = useState<NatSpec | null>(null);
  const [safeInfo, setSafeInfo] = useState<GnosisSafeInfo | null>(null);
  const [detectedEOAs, setDetectedEOAs] = useState<Set<string>>(new Set());
  const [implementationName, setImplementationName] = useState<string | null>(null);

  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const toggleRawValue = (name: string) => {
    setShowRawValues((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(name)) {
        newSet.delete(name);
      } else {
        newSet.add(name);
      }
      return newSet;
    });
  };

  // Get raw string representation of a value
  const getRawValue = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value))
      return JSON.stringify(value.map((v) => (typeof v === "bigint" ? v.toString() : v)));
    if (typeof value === "object") {
      const processed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (isNaN(Number(k))) {
          processed[k] = typeof v === "bigint" ? v.toString() : v;
        }
      }
      return JSON.stringify(processed);
    }
    return String(value);
  };

  useEffect(() => {
    async function loadContract() {
      // Skip if already visited (prevent infinite loops)
      if (stableVisitedAddresses.has(address.toLowerCase())) {
        setContractData((prev) => ({
          ...prev,
          isLoading: false,
          error: "Already visited (circular reference)",
        }));
        return;
      }

      try {
        // Check if address is a contract (not an EOA)
        const contractCheck = await isContract(address);
        if (!isMountedRef.current) return;

        if (!contractCheck) {
          setContractData({
            address,
            name: "EOA (Wallet)",
            values: [],
            isLoading: false,
            error: "This is an EOA (externally owned account), not a contract",
          });
          return;
        }

        // Fetch all data in parallel
        const [name, contractResult] = await Promise.all([
          getContractName(address),
          readAllViewValues(address),
        ]);

        if (!isMountedRef.current) return;

        const { values, abi, implementationAddress } = contractResult;

        // Fetch NatSpec, Gnosis Safe info, and implementation name in parallel
        const natspecAddress = implementationAddress || address;
        const [natspecResult, safeResult, implName] = await Promise.all([
          getContractNatSpec(natspecAddress).catch(() => null),
          getGnosisSafeInfo(address).catch(() => null),
          implementationAddress ? getContractName(implementationAddress).catch(() => null) : Promise.resolve(null),
        ]);

        if (!isMountedRef.current) return;

        if (implName) {
          setImplementationName(implName);
        }

        // Use on-chain name() if Etherscan returns a generic name
        let displayName = name || undefined;
        const genericNames = [
          "vyper_contract",
          "contract",
          "proxy",
          "upgradeable",
          "gnosissafeproxy",
          "gnosissafe",
        ];
        if (!displayName || genericNames.includes(displayName.toLowerCase())) {
          if (safeResult) {
            displayName = `Gnosis Safe (${safeResult.threshold}/${safeResult.owners.length})`;
          } else {
            const onChainName = values.find((v) => v.name === "name" && typeof v.value === "string");
            if (onChainName?.value) {
              displayName = onChainName.value as string;
            }
          }
        }

        setContractData({
          address,
          name: displayName,
          values,
          isLoading: false,
          abi,
          implementationAddress,
        });
        setNatspec(natspecResult);
        setSafeInfo(safeResult);
      } catch (error) {
        if (!isMountedRef.current) return;
        setContractData((prev) => ({
          ...prev,
          isLoading: false,
          error: error instanceof Error ? error.message : "Failed to load contract",
        }));
      }
    }

    loadContract();
  }, [address, stableVisitedAddresses]);

  // Pre-fetch contract names for linked addresses
  useEffect(() => {
    if (contractData.isLoading || depth >= maxDepth) return;

    const linkedAddrs = extractAddresses(contractData.values);
    const addressesToPrefetch = linkedAddrs
      .filter(
        ({ address: addr }) =>
          !prefetchedNames.has(addr.toLowerCase()) &&
          !stableVisitedAddresses.has(addr.toLowerCase()) &&
          !isZeroAddress(addr) &&
          contractData.implementationAddress?.toLowerCase() !== addr.toLowerCase()
      )
      .slice(0, 5);

    if (addressesToPrefetch.length === 0) return;

    const newEOAs: string[] = [];

    Promise.all(
      addressesToPrefetch.map(async ({ address: addr }) => {
        const normalized = addr.toLowerCase();

        if (knownEOAs.has(normalized)) {
          newEOAs.push(normalized);
          return;
        }

        const isContractAddr = await isContract(addr).catch(() => true);
        if (!isContractAddr) {
          knownEOAs.add(normalized);
          newEOAs.push(normalized);
          return;
        }

        if (!prefetchedNames.has(normalized)) {
          prefetchedNames.set(normalized, null);
          const name = await getContractName(addr).catch(() => null);
          prefetchedNames.set(normalized, name);
        }
      })
    ).then(() => {
      if (isMountedRef.current && newEOAs.length > 0) {
        setDetectedEOAs((prev) => {
          const updated = new Set(prev);
          newEOAs.forEach((addr) => updated.add(addr));
          return updated;
        });
      }
    });
  }, [
    contractData.isLoading,
    contractData.values,
    depth,
    maxDepth,
    stableVisitedAddresses,
    contractData.implementationAddress,
  ]);

  const toggleAddress = (addr: string) => {
    const normalized = addr.toLowerCase();
    setExpandedAddresses((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(normalized)) {
        newSet.delete(normalized);
      } else {
        newSet.add(normalized);
      }
      return newSet;
    });
  };

  // Memoize new visited addresses set to avoid recreating on every render
  const newVisitedAddresses = useMemo(() => {
    const set = new Set(stableVisitedAddresses);
    set.add(address.toLowerCase());
    return set;
  }, [stableVisitedAddresses, address]);

  // Extract linked addresses from values
  const linkedAddresses = extractAddresses(contractData.values);
  const linkedCount = linkedAddresses.length;

  // Depth colors - neutral borders that don't imply links
  const depthColors = [
    "border-[var(--border)]",
    "border-[var(--muted-foreground)]",
    "border-[var(--success)]",
    "border-[var(--rainbow-red)]",
    "border-[var(--foreground)]/50",
  ];

  const borderColor = depthColors[depth % depthColors.length];

  // Render a single value with potential nested contract
  const renderValue = (name: string, value: unknown, type: string) => {
    const isAddressType = type === "address";
    const isAddressArray = type === "address[]" && Array.isArray(value);
    const isShowingRaw = showRawValues.has(name);

    if (isAddressArray) {
      const addresses = value as string[];
      if (addresses.length === 0) {
        return <span className="text-[var(--muted-foreground)]">[]</span>;
      }
      return (
        <div className="space-y-1">
          {addresses.map((addr, idx) => (
            <div key={idx}>{renderAddressButton(addr)}</div>
          ))}
        </div>
      );
    }

    if (isAddressType && isValidAddress(value)) {
      return renderAddressButton(value as string);
    }

    const formattedValue = formatValue(value, type, name);
    const rawValue = getRawValue(value);
    const hasFormattedDiff = formattedValue !== rawValue;

    return (
      <span
        onClick={hasFormattedDiff ? () => toggleRawValue(name) : undefined}
        className={`mono text-sm break-all ${
          hasFormattedDiff
            ? "cursor-pointer hover:bg-[var(--muted)] px-1 -mx-1 rounded transition-colors"
            : ""
        } ${isShowingRaw ? "text-[var(--warning)]" : "text-[var(--foreground)]"}`}
        title={
          hasFormattedDiff
            ? isShowingRaw
              ? "Click to show formatted"
              : "Click to show raw value"
            : undefined
        }
      >
        {isShowingRaw ? rawValue : formattedValue}
        {hasFormattedDiff && (
          <span className="text-[var(--muted-foreground)] text-xs ml-2">
            {isShowingRaw ? "(raw)" : "(formatted)"}
          </span>
        )}
      </span>
    );
  };

  // Render an address value with expand capability
  const renderAddressButton = (addr: string) => {
    const normalized = addr.toLowerCase();
    const isZero = isZeroAddress(addr);
    const isExpanded = expandedAddresses.has(normalized);
    const isImplementation = contractData.implementationAddress?.toLowerCase() === normalized;
    const isEOA = knownEOAs.has(normalized) || detectedEOAs.has(normalized);
    const canExpand =
      depth < maxDepth &&
      !isZero &&
      !isImplementation &&
      !isEOA &&
      !stableVisitedAddresses.has(normalized);

    return (
      <button
        onClick={() => canExpand && toggleAddress(addr)}
        disabled={isZero || isImplementation || isEOA || !canExpand}
        className={`mono text-sm break-all text-left flex items-center gap-2 ${
          isZero || isImplementation || isEOA
            ? "text-[var(--muted-foreground)] cursor-not-allowed"
            : canExpand
              ? "text-[var(--foreground)] hover:text-[var(--accent)] cursor-pointer"
              : "text-[var(--muted-foreground)]"
        }`}
        title={
          isZero
            ? "Zero address"
            : isImplementation
              ? "Implementation contract (no state)"
              : isEOA
                ? "EOA (wallet)"
                : canExpand
                  ? "Click to expand"
                  : "Max depth reached"
        }
      >
        {/* Fixed-width indicator slot to prevent text shifting */}
        {canExpand && (
          <span className="w-4 inline-block shrink-0">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
        <span className="break-all">{addr}</span>
        {isImplementation && (
          <span className="text-xs bg-[var(--muted)] px-1 rounded text-[var(--muted-foreground)]">impl</span>
        )}
        {isEOA && (
          <span className="text-xs bg-[var(--muted)] px-1 rounded">EOA</span>
        )}
      </button>
    );
  };

  // Check if an address is expanded
  const isAddressExpanded = (addr: string) => {
    const normalized = addr.toLowerCase();
    const isZero = isZeroAddress(addr);
    const isExpanded = expandedAddresses.has(normalized);
    const isImplementation = contractData.implementationAddress?.toLowerCase() === normalized;
    const isEOA = knownEOAs.has(normalized) || detectedEOAs.has(normalized);
    const canExpand =
      depth < maxDepth &&
      !isZero &&
      !isImplementation &&
      !isEOA &&
      !stableVisitedAddresses.has(normalized);
    return isExpanded && canExpand;
  };

  return (
    <div
      className={`bg-[var(--background)] rounded-lg border-l-4 ${borderColor} overflow-hidden border border-[var(--border)]`}
    >
      {/* Header */}
      <div
        className={`flex items-start gap-2 p-4 transition-colors ${
          depth > 0 ? "cursor-pointer hover:bg-[var(--muted)]/50" : ""
        }`}
        onClick={depth > 0 ? () => setIsCollapsed(!isCollapsed) : undefined}
      >
        {depth > 0 && (
          <span className="text-[var(--muted-foreground)] w-5 inline-block text-center shrink-0 mt-1">
            {isCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          </span>
        )}
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-2 flex-wrap">
            {contractData.isLoading ? (
              <span className="inline-block h-5 w-32 bg-[var(--muted)] animate-pulse rounded" />
            ) : (
              <h2
                className={`font-semibold text-[var(--foreground)] break-words ${
                  depth === 0 ? "text-lg" : "text-base"
                }`}
              >
                {contractData.name || "Contract"}
              </h2>
            )}
            {sourceName && (
              <span className="text-xs bg-[var(--muted)] px-2 py-1 rounded text-[var(--muted-foreground)] shrink-0">
                {sourceName}
              </span>
            )}
            {contractData.implementationAddress && (
              <span className="text-xs bg-[var(--muted)] px-2 py-1 rounded text-[var(--muted-foreground)] shrink-0">Proxy</span>
            )}
            {safeInfo && (
              <span className="text-xs bg-[var(--success)] px-2 py-1 rounded text-white shrink-0">
                Multisig {safeInfo.threshold}/{safeInfo.owners.length}
              </span>
            )}
            {!contractData.isLoading && linkedCount > 0 && (
              <span className="text-xs bg-[var(--muted)] px-2 py-1 rounded text-[var(--muted-foreground)] shrink-0">
                {linkedCount} linked
              </span>
            )}
          </div>
          <a
            href={`https://etherscan.io/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--muted-foreground)] hover:text-[var(--accent)] mono break-all block"
            onClick={(e) => e.stopPropagation()}
          >
            {address}
          </a>
          {contractData.implementationAddress && (
            <a
              href={`https://etherscan.io/address/${contractData.implementationAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--muted-foreground)]/70 hover:text-[var(--accent)] break-all block"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="mono">impl: {contractData.implementationAddress}</span>
              {implementationName && (
                <span className="ml-2 text-[var(--muted-foreground)]">({implementationName})</span>
              )}
            </a>
          )}
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="px-4 pb-4">
          {/* Contract-level documentation */}
          {natspec?.contractNotice && (
            <div className="bg-[var(--muted)]/50 border border-[var(--border)] rounded p-3 mb-4">
              <p className="text-[var(--muted-foreground)] text-sm italic">{natspec.contractNotice}</p>
            </div>
          )}

          {contractData.error && (
            <div className="bg-[var(--destructive)]/10 border border-[var(--destructive)]/30 rounded p-3 mb-4">
              <p className="text-[var(--destructive)] text-sm">{contractData.error}</p>
            </div>
          )}

          {contractData.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={32} className="animate-spin text-[var(--accent)]" />
              <span className="ml-3 text-[var(--muted-foreground)]">Loading contract data...</span>
            </div>
          ) : (
            <>
              {/* Values */}
              {contractData.values.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-[var(--muted-foreground)] uppercase tracking-wide mb-3">
                    Read Values ({contractData.values.length})
                  </h3>
                  <div className="bg-[var(--muted)]/30 rounded-lg p-4 space-y-1">
                    {contractData.values.map((val) => {
                      const funcDoc = natspec?.functions[val.name];

                      const getExpandedAddresses = (): string[] => {
                        if (
                          val.type === "address" &&
                          isValidAddress(val.value) &&
                          isAddressExpanded(val.value as string)
                        ) {
                          return [val.value as string];
                        }
                        if (val.type === "address[]" && Array.isArray(val.value)) {
                          return (val.value as string[]).filter(
                            (addr) => isValidAddress(addr) && isAddressExpanded(addr)
                          );
                        }
                        return [];
                      };
                      const expandedAddrs = getExpandedAddresses();

                      return (
                        <div
                          key={val.name}
                          className="py-2 border-b border-[var(--border)]/50 last:border-b-0"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                            <div className="sm:w-1/3 flex-shrink-0">
                              <span className="text-[var(--muted-foreground)] font-medium">
                                {val.name}
                              </span>
                              <span className="text-[var(--muted-foreground)]/60 text-xs ml-1">
                                ({val.type})
                              </span>
                            </div>
                            <div className="sm:w-2/3">
                              {val.error ? (
                                <span className="text-[var(--destructive)] text-sm">{val.error}</span>
                              ) : (
                                renderValue(val.name, val.value, val.type)
                              )}
                            </div>
                          </div>
                          {funcDoc?.notice && (
                            <p className="text-[var(--muted-foreground)] text-xs mt-1 italic">
                              {funcDoc.notice}
                            </p>
                          )}
                          {expandedAddrs.map((addr) => (
                            <div key={addr} className="mt-3">
                              <ContractView
                                address={addr}
                                sourceName={
                                  val.type === "address[]"
                                    ? `${val.name}[${(val.value as string[]).indexOf(addr)}]`
                                    : val.name
                                }
                                depth={depth + 1}
                                maxDepth={maxDepth}
                                visitedAddresses={newVisitedAddresses}
                                defaultCollapsed={false}
                              />
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {contractData.values.length === 0 && !contractData.error && !safeInfo && (
                <p className="text-[var(--muted-foreground)]">No view functions found</p>
              )}

              {/* Gnosis Safe Info */}
              {safeInfo && (
                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-[var(--muted-foreground)] uppercase tracking-wide mb-3">
                    Multisig Signers ({safeInfo.threshold}/{safeInfo.owners.length} required)
                  </h3>
                  <div className="bg-[var(--muted)]/30 rounded-lg p-4 space-y-2">
                    {safeInfo.owners.map((owner, idx) => (
                      <div key={owner} className="flex items-center gap-2">
                        <span className="text-[var(--muted-foreground)] text-sm w-6">{idx + 1}.</span>
                        <a
                          href={`https://etherscan.io/address/${owner}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mono text-sm text-[var(--muted-foreground)] hover:text-[var(--accent)]"
                        >
                          {owner}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
