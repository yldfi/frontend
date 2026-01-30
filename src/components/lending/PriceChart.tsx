"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, AreaSeries, Time, AreaData } from "lightweight-charts";

interface PriceChartProps {
  // Current price and liquidation prices
  currentPrice?: number;
  liquidationPriceUpper?: number;
  liquidationPriceLower?: number;
  // Token symbol for display
  symbol: string;
  // Price history data (optional, will show placeholder if not provided)
  priceData?: { time: number; value: number }[];
  // Height of the chart
  height?: number;
  // Show liquidation bands
  showLiquidationBands?: boolean;
}

export function PriceChart({
  currentPrice,
  liquidationPriceUpper,
  liquidationPriceLower,
  symbol,
  priceData,
  height = 200,
  showLiquidationBands = true,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  // Loading state derived from priceData prop
  const isLoading = !priceData || priceData.length === 0;

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    // Get CSS variable colors
    const computedStyle = getComputedStyle(document.documentElement);
    const bgColor = computedStyle.getPropertyValue("--background").trim() || "#0a0a0a";
    const textColor = computedStyle.getPropertyValue("--muted-foreground").trim() || "#666";
    const borderColor = computedStyle.getPropertyValue("--border").trim() || "#222";
    const accentColor = computedStyle.getPropertyValue("--accent").trim() || "#00f0ff";

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: textColor,
        fontFamily: "inherit",
      },
      grid: {
        vertLines: { color: borderColor, style: 1 },
        horzLines: { color: borderColor, style: 1 },
      },
      width: containerRef.current.clientWidth,
      height,
      rightPriceScale: {
        borderColor: borderColor,
        scaleMargins: {
          top: 0.2,
          bottom: 0.2,
        },
      },
      timeScale: {
        borderColor: borderColor,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        horzLine: {
          color: textColor,
          labelBackgroundColor: bgColor,
        },
        vertLine: {
          color: textColor,
          labelBackgroundColor: bgColor,
        },
      },
    });

    chartRef.current = chart;

    // Create area series for price
    const series = chart.addSeries(AreaSeries, {
      lineColor: accentColor,
      topColor: `${accentColor}33`,
      bottomColor: `${accentColor}00`,
      lineWidth: 2,
      priceLineVisible: false,
    });

    seriesRef.current = series;

    // Handle resize
    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [height]);

  // Update chart data
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    if (priceData && priceData.length > 0) {
      // Format data for the chart
      const formattedData: AreaData[] = priceData.map((d) => ({
        time: d.time as Time,
        value: d.value,
      }));

      seriesRef.current.setData(formattedData);

      // Add liquidation price lines if showing bands
      if (showLiquidationBands && liquidationPriceUpper && liquidationPriceLower) {
        // Create price lines for liquidation levels
        seriesRef.current.createPriceLine({
          price: liquidationPriceUpper,
          color: "#f59e0b",
          lineWidth: 1,
          lineStyle: 2, // Dashed
          axisLabelVisible: true,
          title: "Soft Liq.",
        });

        seriesRef.current.createPriceLine({
          price: liquidationPriceLower,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: 2, // Dashed
          axisLabelVisible: true,
          title: "Full Liq.",
        });
      }

      // Add current price line
      if (currentPrice) {
        seriesRef.current.createPriceLine({
          price: currentPrice,
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: 0, // Solid
          axisLabelVisible: true,
          title: "Current",
        });
      }

      // Fit content
      chartRef.current.timeScale().fitContent();
    } else {
      // Show placeholder data
      const now = Math.floor(Date.now() / 1000);
      const placeholderData: AreaData[] = [];
      const basePrice = currentPrice || 1;

      // Generate 24 hours of placeholder data
      for (let i = 24; i >= 0; i--) {
        const time = now - i * 3600;
        // Add some random variation around the current price
        const variation = (Math.random() - 0.5) * basePrice * 0.05;
        placeholderData.push({
          time: time as Time,
          value: basePrice + variation,
        });
      }

      seriesRef.current.setData(placeholderData);
      chartRef.current.timeScale().fitContent();
    }
  }, [priceData, currentPrice, liquidationPriceUpper, liquidationPriceLower, showLiquidationBands]);

  return (
    <div className="relative">
      {/* Chart header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-[var(--muted-foreground)]">{symbol} Price</span>
        {showLiquidationBands && (
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 bg-yellow-500" />
              <span className="text-[var(--muted-foreground)]">Soft Liq.</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 bg-red-500" />
              <span className="text-[var(--muted-foreground)]">Full Liq.</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 bg-green-500" />
              <span className="text-[var(--muted-foreground)]">Current</span>
            </div>
          </div>
        )}
      </div>

      {/* Chart container */}
      <div
        ref={containerRef}
        className="rounded-lg overflow-hidden border border-[var(--border)]"
        style={{ height }}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)]/50">
          <div className="text-sm text-[var(--muted-foreground)]">Loading chart data...</div>
        </div>
      )}

      {/* Price legend */}
      {currentPrice && (
        <div className="flex items-center justify-between mt-2 text-xs text-[var(--muted-foreground)]">
          <span>
            Current:{" "}
            <span className="text-[var(--foreground)] mono">
              ${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </span>
          </span>
          {liquidationPriceUpper && (
            <span>
              Soft Liq.:{" "}
              <span className="text-yellow-500 mono">
                ${liquidationPriceUpper.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </span>
            </span>
          )}
          {liquidationPriceLower && (
            <span>
              Full Liq.:{" "}
              <span className="text-red-500 mono">
                ${liquidationPriceLower.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
