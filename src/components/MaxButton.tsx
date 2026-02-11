"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface MaxButtonProps {
  balance: string;
  onSelect: (amount: string) => void;
  showClose?: boolean;
  onClose?: () => void;
}

export function MaxButton({ balance, onSelect, showClose, onClose }: MaxButtonProps) {
  const [isHovered, setIsHovered] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const balanceNum = parseFloat(balance) || 0;

  const handlePercentage = (percent: number) => {
    if (percent === 0) {
      onSelect("");
    } else if (percent === 100) {
      onSelect(balance);
    } else {
      const amount = balanceNum * (percent / 100);
      onSelect(amount.toString());
    }
    // Hide menu after selection
    setIsHovered(false);
  };

  // Show menu immediately on hover
  const handleMouseEnter = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setIsHovered(true);
  }, []);

  // Delay hiding to allow moving to other buttons
  const handleMouseLeave = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 150);
  }, []);

  return (
    <div className="relative">
      {/* Unified semi-transparent backdrop - spans all buttons on hover */}
      <div
        className={cn(
          "absolute right-0 rounded-lg bg-[var(--background)]/40 transition-opacity duration-200 z-0 pointer-events-none",
          showClose ? "-top-[116px] -bottom-[28px] -left-1.5 -right-1.5" : "-top-[116px] -bottom-1.5 -left-1.5 -right-1.5",
          isHovered ? "opacity-100" : "opacity-0"
        )}
      />

      {/* Floating percentage options - stacked vertically above MAX */}
      <div
        className={cn(
          "absolute bottom-full right-0 pb-1 flex flex-col gap-1 transition-[opacity,transform] duration-200 ease-out z-10",
          isHovered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none"
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {[0, 25, 50, 75].map((percent) => (
          <button
            key={percent}
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handlePercentage(percent)}
            className="relative shrink-0 px-2 py-1 text-xs font-medium bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors cursor-pointer"
          >
            {percent}%
          </button>
        ))}
      </div>

      {/* Main MAX button - hover trigger */}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => handlePercentage(100)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="relative z-10 shrink-0 px-2 py-1 text-xs font-medium bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors cursor-pointer"
      >
        MAX
      </button>

      {/* Floating CLOSE option - appears below MAX on hover */}
      {showClose && onClose && (
        <div
          className={cn(
            "absolute top-full right-0 pt-1 transition-[opacity,transform] duration-200 ease-out z-10",
            isHovered ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 pointer-events-none"
          )}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose();
              setIsHovered(false);
            }}
            className="relative shrink-0 px-2 h-[24px] flex items-center text-[8px] font-medium tracking-wide bg-[var(--background)] text-[var(--accent)]/70 hover:text-[var(--accent)] rounded transition-colors cursor-pointer"
          >
            CLOSE
          </button>
        </div>
      )}

    </div>
  );
}
