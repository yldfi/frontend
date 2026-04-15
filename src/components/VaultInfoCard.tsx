"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  CrosshairMode,
  AreaSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type AreaData,
  type HistogramData,
} from "lightweight-charts";
import { Info, TrendingUp, Wallet } from "lucide-react";
import { useVaultTvlHistory, useVault30dApyHistory, type HistoryPoint, type ApyPoint } from "@/hooks/useYearnHistory";
import { formatUsd } from "@/lib/utils";

const TIME_RANGES = ["30d", "90d", "all"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

const TAB_KEY = "yldfi-vault-info-tab";

const TVL_COLOR = "#94a3b8";

function filterByRange<T extends { time: number }>(points: T[], range: TimeRange): T[] {
  if (range === "all") return points;
  const days = range === "30d" ? 30 : 90;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return points.filter((p) => p.time >= cutoff);
}

// Format a USD value for Y-axis ticks and tooltips.
function formatShortUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

interface PerformanceChartProps {
  apyData: ApyPoint[];
  height?: number;
}

function PerformanceChart({ apyData, height = 320 }: PerformanceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const apySeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const accentColorRef = useRef("#f59e0b");

  const [tooltip, setTooltip] = useState<{
    x: number;
    visible: boolean;
    time: string;
    apy: number | null;
  }>({ x: 0, visible: false, time: "", apy: null });

  useEffect(() => {
    if (!containerRef.current) return;

    const cs = getComputedStyle(document.documentElement);
    const textColor = cs.getPropertyValue("--muted-foreground").trim() || "#666";
    const borderColor = cs.getPropertyValue("--border").trim() || "#222";
    const accentColor = cs.getPropertyValue("--accent").trim() || "#f59e0b";
    accentColorRef.current = accentColor;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor,
        fontFamily: "inherit",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: `${borderColor}66`, style: LineStyle.Dotted },
        horzLines: { color: `${borderColor}66`, style: LineStyle.Dotted },
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      rightPriceScale: { borderColor, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor, timeVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: { color: textColor, labelBackgroundColor: "#1a1a1a" },
        vertLine: { color: textColor, labelBackgroundColor: "#1a1a1a" },
      },
      handleScroll: { vertTouchDrag: false },
    });
    chartRef.current = chart;

    apySeriesRef.current = chart.addSeries(AreaSeries, {
      lineColor: accentColor,
      topColor: `${accentColor}40`,
      bottomColor: `${accentColor}00`,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      priceFormat: {
        type: "custom",
        formatter: (v: number) => `${v.toFixed(1)}%`,
        minMove: 0.01,
      },
    });

    chart.subscribeCrosshairMove((param) => {
      const container = containerRef.current;
      if (!container || !param.time || !param.point || param.point.x < 0 || param.point.x > container.clientWidth) {
        setTooltip((p) => ({ ...p, visible: false }));
        return;
      }
      const apyData = apySeriesRef.current ? param.seriesData.get(apySeriesRef.current) : null;
      const apy = apyData && "value" in apyData ? (apyData.value as number) : null;
      const dateStr = new Date((param.time as number) * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const tooltipW = 160;
      let left = param.point.x + 12;
      if (left + tooltipW > container.clientWidth) left = param.point.x - tooltipW - 12;
      setTooltip({ x: left, visible: true, time: dateStr, apy });
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth > 0 && clientHeight > 0) chart.applyOptions({ width: clientWidth, height: clientHeight });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      apySeriesRef.current = null;
    };
  }, []);

  // Feed data
  useEffect(() => {
    if (!chartRef.current || !apySeriesRef.current) return;
    const apyArea: AreaData[] = apyData
      .filter((p) => p.apy !== null)
      .map((p) => ({ time: p.time as Time, value: p.apy as number }));
    apySeriesRef.current.setData(apyArea);
    chartRef.current.timeScale().fitContent();
  }, [apyData]);

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-3 mb-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5" style={{ backgroundColor: "var(--accent)" }} />
          30D APY
        </span>
      </div>
      <div ref={containerRef} style={{ height, width: "100%" }} />
      {tooltip.visible && tooltip.apy !== null && (
        <div
          className="absolute z-10 pointer-events-none bg-[#1a1a1a] border border-[var(--border)] rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ left: tooltip.x, top: 30, minWidth: 150 }}
        >
          <div className="text-[var(--muted-foreground)] mb-1">{tooltip.time}</div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "var(--accent)" }}>30D APY</span>
            <span className="mono">{tooltip.apy.toFixed(2)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface TvlChartProps {
  tvlData: HistoryPoint[];
  height?: number;
}

function TvlChart({ tvlData, height = 320 }: TvlChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [tooltip, setTooltip] = useState<{ x: number; visible: boolean; time: string; tvl: number }>({
    x: 0,
    visible: false,
    time: "",
    tvl: 0,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const cs = getComputedStyle(document.documentElement);
    const textColor = cs.getPropertyValue("--muted-foreground").trim() || "#666";
    const borderColor = cs.getPropertyValue("--border").trim() || "#222";
    const accentColor = cs.getPropertyValue("--accent").trim() || "#f59e0b";

    const chart = createChart(containerRef.current, {
      localization: { priceFormatter: formatShortUsd },
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor,
        fontFamily: "inherit",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: `${borderColor}66`, style: LineStyle.Dotted },
        horzLines: { color: `${borderColor}66`, style: LineStyle.Dotted },
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      rightPriceScale: { borderColor, scaleMargins: { top: 0.1, bottom: 0.05 } },
      timeScale: { borderColor, timeVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: { color: textColor, labelBackgroundColor: "#1a1a1a" },
        vertLine: { color: textColor, labelBackgroundColor: "#1a1a1a" },
      },
      handleScroll: { vertTouchDrag: false },
    });
    chartRef.current = chart;

    const series = chart.addSeries(HistogramSeries, {
      color: accentColor,
      priceFormat: { type: "custom", formatter: formatShortUsd, minMove: 1 },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      const container = containerRef.current;
      if (!container || !param.time || !param.point || param.point.x < 0 || param.point.x > container.clientWidth) {
        setTooltip((p) => ({ ...p, visible: false }));
        return;
      }
      const d = param.seriesData.get(series);
      const value = d && "value" in d ? (d.value as number) : 0;
      const dateStr = new Date((param.time as number) * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const tooltipW = 160;
      let left = param.point.x + 12;
      if (left + tooltipW > container.clientWidth) left = param.point.x - tooltipW - 12;
      setTooltip({ x: left, visible: true, time: dateStr, tvl: value });
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth > 0 && clientHeight > 0) chart.applyOptions({ width: clientWidth, height: clientHeight });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const cs = getComputedStyle(document.documentElement);
    const accentColor = cs.getPropertyValue("--accent").trim() || "#f59e0b";
    const data: HistogramData[] = tvlData.map((p) => ({
      time: p.time as Time,
      value: p.value,
      color: `${accentColor}AA`,
    }));
    seriesRef.current.setData(data);
    chartRef.current.timeScale().fitContent();
  }, [tvlData]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height, width: "100%" }} />
      {tooltip.visible && (
        <div
          className="absolute z-10 pointer-events-none bg-[#1a1a1a] border border-[var(--border)] rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ left: tooltip.x, top: 12, minWidth: 140 }}
        >
          <div className="text-[var(--muted-foreground)] mb-1">{tooltip.time}</div>
          <div className="flex justify-between gap-3">
            <span className="text-[var(--muted-foreground)]">TVL</span>
            <span className="mono">{formatUsd(tooltip.tvl)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface VaultInfoCardProps {
  address: string;
  chainId?: number;
  title: string;
  detailsContent: ReactNode;
}

type TabKey = "details" | "performance" | "tvl";

export function VaultInfoCard({ address, chainId = 1, title, detailsContent }: VaultInfoCardProps) {
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof window === "undefined") return "details";
    const stored = window.localStorage.getItem(TAB_KEY);
    return stored === "performance" || stored === "tvl" ? stored : "details";
  });
  const [range, setRange] = useState<TimeRange>("30d");

  const tvlQuery = useVaultTvlHistory(address, chainId, 365);
  const apyQuery = useVault30dApyHistory(address, chainId);

  const tvlRanged = useMemo(() => filterByRange(tvlQuery.data ?? [], range), [tvlQuery.data, range]);
  const apyRanged = useMemo(() => filterByRange(apyQuery.data ?? [], range), [apyQuery.data, range]);

  const changeTab = (next: TabKey) => {
    setTab(next);
    if (typeof window !== "undefined") window.localStorage.setItem(TAB_KEY, next);
  };

  const hasApy = (apyQuery.data?.length ?? 0) > 0;
  const hasTvl = (tvlQuery.data?.length ?? 0) > 0;

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden">
      <div className="flex items-stretch border-b border-[var(--border)] bg-[var(--muted)]/20">
        <TabButton active={tab === "details"} onClick={() => changeTab("details")}>
          <Info size={13} />
          <span>{title}</span>
        </TabButton>
        <TabButton active={tab === "performance"} onClick={() => changeTab("performance")}>
          <TrendingUp size={13} />
          <span>Performance</span>
        </TabButton>
        <TabButton active={tab === "tvl"} onClick={() => changeTab("tvl")}>
          <Wallet size={13} />
          <span>TVL</span>
        </TabButton>
      </div>

      {tab === "details" ? (
        <div>{detailsContent}</div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-end gap-1 text-xs">
            {TIME_RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2.5 py-1 rounded-md transition-colors mono ${
                  range === r
                    ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          {tab === "performance" && (
            <>
              {apyQuery.isLoading ? (
                <div className="h-[320px] flex items-center justify-center text-xs text-[var(--muted-foreground)]">Loading…</div>
              ) : hasApy ? (
                <PerformanceChart apyData={apyRanged} />
              ) : (
                <div className="h-[320px] flex items-center justify-center text-xs text-[var(--muted-foreground)]">
                  No performance history available
                </div>
              )}
            </>
          )}

          {tab === "tvl" && (
            <>
              {tvlQuery.isLoading ? (
                <div className="h-[320px] flex items-center justify-center text-xs text-[var(--muted-foreground)]">Loading…</div>
              ) : hasTvl ? (
                <TvlChart tvlData={tvlRanged} />
              ) : (
                <div className="h-[320px] flex items-center justify-center text-xs text-[var(--muted-foreground)]">
                  No TVL history available
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-r border-[var(--border)] last:border-r-0 ${
        active
          ? "text-[var(--foreground)] bg-[var(--background)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      }`}
    >
      {children}
    </button>
  );
}
