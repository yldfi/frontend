import { ArrowRightLeft } from "lucide-react";

import {
  formatTxAssetAmount,
  isSameTxAssetPair,
  type TxAssetDetails,
} from "@/lib/transaction-ui";
import { cn } from "@/lib/utils";

interface TxAssetDetailsPillProps {
  details: TxAssetDetails;
  actionLabel?: string;
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}

function TokenIcon({
  src,
  symbol,
  className,
}: {
  src?: string;
  symbol: string;
  className?: string;
}) {
  if (!src) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={symbol} className={cn("rounded-full shrink-0", className)} />
  );
}

export function TxAssetDetailsPill({
  details,
  actionLabel,
  className,
  iconClassName = "w-5 h-5",
  textClassName = "text-sm",
}: TxAssetDetailsPillProps) {
  const fromAmount = formatTxAssetAmount(details.fromAmount);
  const toAmount = formatTxAssetAmount(details.toAmount);
  const sameAsset = isSameTxAssetPair(details);

  if (sameAsset) {
    return (
      <div
        className={cn(
          "inline-flex max-w-full min-w-0 items-center justify-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg",
          className
        )}
      >
        <TokenIcon src={details.fromLogo || details.toLogo} symbol={details.fromSymbol} className={iconClassName} />
        <span className={cn("mono min-w-0 max-w-full truncate", textClassName)} title={`${details.fromAmount} ${details.fromSymbol}`}>
          {actionLabel ? `${actionLabel} ` : ""}{fromAmount} {details.fromSymbol}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex max-w-full min-w-0 flex-wrap items-center justify-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg",
        className
      )}
    >
      <TokenIcon src={details.fromLogo} symbol={details.fromSymbol} className={iconClassName} />
      <span className={cn("mono min-w-0 max-w-full truncate", textClassName)} title={`${details.fromAmount} ${details.fromSymbol}`}>
        {fromAmount} {details.fromSymbol}
      </span>
      <ArrowRightLeft size={14} className="text-[var(--muted-foreground)] shrink-0" />
      <TokenIcon src={details.toLogo} symbol={details.toSymbol} className={iconClassName} />
      <span className={cn("mono min-w-0 max-w-full truncate", textClassName)} title={`${details.toAmount} ${details.toSymbol}`}>
        {toAmount} {details.toSymbol}
      </span>
    </div>
  );
}
