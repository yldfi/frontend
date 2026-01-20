"use client";

import { useStrategyFlow } from "@/hooks/useStrategyFlow";
import { StrategyFlowDiagram } from "./StrategyFlowDiagram";

interface StrategyFlowViewerProps {
  address: string;
  chainId?: number;
}

/**
 * Skeleton loader for strategy flow
 */
function StrategyFlowSkeleton() {
  return (
    <div className="mono text-xs p-4 bg-[var(--muted)] rounded-lg border border-[var(--border)] animate-pulse">
      <div className="h-4 bg-[var(--border)] rounded w-1/3 mb-4" />
      <div className="space-y-2">
        <div className="h-3 bg-[var(--border)] rounded w-full" />
        <div className="h-3 bg-[var(--border)] rounded w-4/5" />
        <div className="h-3 bg-[var(--border)] rounded w-full" />
        <div className="h-3 bg-[var(--border)] rounded w-3/4" />
      </div>
      <div className="h-4 bg-[var(--border)] rounded w-1/4 mt-6 mb-4" />
      <div className="space-y-2">
        <div className="h-3 bg-[var(--border)] rounded w-full" />
        <div className="h-3 bg-[var(--border)] rounded w-5/6" />
        <div className="h-3 bg-[var(--border)] rounded w-full" />
      </div>
    </div>
  );
}

/**
 * Complete strategy flow viewer - fetches, parses, and displays the static diagram
 */
export function StrategyFlowViewer({
  address,
  chainId = 1,
}: StrategyFlowViewerProps) {
  const { flow, parsed, isLoading, error } = useStrategyFlow(address, chainId);

  if (isLoading) {
    return <StrategyFlowSkeleton />;
  }

  if (error) {
    return (
      <div className="mono text-sm bg-[var(--muted)] text-[var(--destructive)] p-4 rounded-lg border border-[var(--border)]">
        <div className="font-bold">Error loading strategy flow</div>
        <div className="text-xs mt-2 text-[var(--muted-foreground)]">{error.message}</div>
        <div className="text-xs mt-1 text-[var(--muted-foreground)]">Address: {address}</div>
      </div>
    );
  }

  if (!flow) {
    return (
      <div className="mono text-sm bg-[var(--muted)] text-[var(--warning)] p-4 rounded-lg border border-[var(--border)]">
        <div className="font-bold">Could not parse strategy</div>
        {parsed?.warnings.map((w, i) => (
          <div key={i} className="text-xs mt-1 text-[var(--muted-foreground)]">
            Warning: {w}
          </div>
        ))}
        {parsed?.errors.map((e, i) => (
          <div key={i} className="text-xs mt-1 text-[var(--destructive)]">
            Error: {e}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <StrategyFlowDiagram config={flow.config} />

      {/* Show warnings if any */}
      {parsed?.warnings && parsed.warnings.length > 0 && (
        <div className="mt-2 text-xs text-[var(--warning)]">
          {parsed.warnings.map((w, i) => (
            <div key={i}>Warning: {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Multi-strategy comparison view
 */
export function StrategyFlowComparison({
  addresses,
  chainId = 1,
}: {
  addresses: string[];
  chainId?: number;
}) {
  return (
    <div className="grid gap-4">
      {addresses.map((address) => (
        <div key={address}>
          <StrategyFlowViewer address={address} chainId={chainId} />
        </div>
      ))}
    </div>
  );
}
