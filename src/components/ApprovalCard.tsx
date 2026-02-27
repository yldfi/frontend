"use client";

import { useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { formatUnits } from "viem";
import { cn } from "@/lib/utils";
import type { PendingApproval, ApprovalProgress } from "@/types/approval";
import { LoadingDots } from "@/components/LoadingDots";

interface ApprovalCardProps {
  show: boolean;
  pendingApproval: PendingApproval | null;
  approvalProgress: ApprovalProgress | null;
  description?: React.ReactNode;
  decimals?: number;
  isApproving: boolean;
  onApprove: (exact: boolean) => void;
}

export function ApprovalCard({
  show,
  pendingApproval,
  approvalProgress,
  description,
  decimals: decimalsProp,
  isApproving,
  onApprove,
}: ApprovalCardProps) {
  const decimals = pendingApproval?.decimals ?? decimalsProp ?? 18;
  const [approvingTypeRaw, setApprovingType] = useState<"exact" | "unlimited" | "single" | null>(null);
  // Derive effective value: reset to null when not approving (avoids setState in useEffect)
  const approvingType = isApproving ? approvingTypeRaw : null;

  const hasMultiStep = approvalProgress && approvalProgress.total > 1;
  const hasExactAmount = pendingApproval?.type !== "controller" && pendingApproval?.amount;

  return (
    <div
      className="grid transition-[grid-template-rows] duration-300 ease-in-out"
      style={{ gridTemplateRows: show ? "1fr" : "0fr" }}
    >
      <div className="overflow-hidden">
        {pendingApproval && (
          <div className="p-3 rounded-lg bg-[var(--muted)]/50 border border-[var(--border)] space-y-3">
            <div className="text-sm font-medium">
              {hasMultiStep ? "Approvals Required" : "Approval Required"}
            </div>

            {/* Multi-step progress */}
            {approvalProgress && hasMultiStep && (
              <div className="space-y-2">
                {approvalProgress.steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="mt-0.5">
                      {s.done ? (
                        <Check size={14} className="text-green-500 shrink-0" />
                      ) : i === approvalProgress.step - 1 ? (
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-[var(--foreground)] shrink-0" />
                      ) : (
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-[var(--foreground)]/30 shrink-0" />
                      )}
                    </div>
                    <div>
                      <div className={cn(
                        "text-sm",
                        s.done
                          ? "text-[var(--muted-foreground)] line-through"
                          : i === approvalProgress.step - 1
                            ? "text-[var(--foreground)] font-medium"
                            : "text-[var(--muted-foreground)]"
                      )}>
                        {s.label}
                      </div>
                      <div className={cn(
                        "text-xs",
                        i === approvalProgress.step - 1
                          ? "text-[var(--muted-foreground)]"
                          : "text-[var(--muted-foreground)]/60"
                      )}>
                        {s.description}{s.spender && <>{" "}<a href={`https://etherscan.io/address/${s.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={10} className="!inline -mt-0.5" /></a></>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Descriptive text (for single-step or descriptive mode) */}
            {!hasMultiStep && (
              <div className="text-sm text-[var(--muted-foreground)]">
                {description ?? (
                  pendingApproval.type === "controller"
                    ? <>Allow {pendingApproval.spenderName ?? "yld Zapper"} to manage position on LlamaLend{" "}<span className="whitespace-nowrap">controller <a href={`https://etherscan.io/address/${pendingApproval.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span></>
                    : <>Allow {pendingApproval.spenderName ?? <><a href={`https://etherscan.io/address/${pendingApproval.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors underline underline-offset-2 decoration-[var(--muted-foreground)]/50">{`${pendingApproval.spender.slice(0, 6)}...${pendingApproval.spender.slice(-4)}`}</a></>}{pendingApproval.spenderName && <>{" "}<a href={`https://etherscan.io/address/${pendingApproval.spender}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={10} className="!inline -mt-0.5" /></a></>} to spend your {pendingApproval.tokenSymbol}</>
                )}
              </div>
            )}

            {/* Approval buttons */}
            {hasExactAmount ? (
              <div className="flex gap-2">
                <button
                  onClick={() => { setApprovingType("exact"); onApprove(true); }}
                  disabled={isApproving}
                  className={cn(
                    "flex-[2] py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                    isApproving
                      ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                  )}
                >
                  {isApproving && approvingType === "exact"
                    ? <>Approving<LoadingDots /></>
                    : `${Number(formatUnits(pendingApproval.amount!, decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${pendingApproval.tokenSymbol}`}
                </button>
                <button
                  onClick={() => { setApprovingType("unlimited"); onApprove(false); }}
                  disabled={isApproving}
                  className={cn(
                    "flex-1 py-2.5 px-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                    isApproving
                      ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                      : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                  )}
                >
                  {isApproving && approvingType === "unlimited" ? <>Approving<LoadingDots /></> : "Max"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setApprovingType("single"); onApprove(false); }}
                disabled={isApproving}
                className={cn(
                  "w-full py-2.5 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                  isApproving
                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                    : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90"
                )}
              >
                {isApproving
                  ? <>Approving<LoadingDots /></>
                  : approvalProgress
                    ? `Approve${approvalProgress.steps[approvalProgress.step - 1]?.label ? ` ${approvalProgress.steps[approvalProgress.step - 1].label}` : ""}${approvalProgress.total > 1 ? ` (${approvalProgress.step}/${approvalProgress.total})` : ""}`
                    : "Approve"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
