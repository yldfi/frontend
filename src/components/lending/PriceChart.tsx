"use client";

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  CrosshairMode,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type AreaData,
  type WhitespaceData,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesType,
  type IPrimitivePaneView,
  type IPrimitivePaneRenderer,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { Maximize2, Minimize2, RefreshCcw } from "lucide-react";
import Image from "next/image";
import { formatUnits } from "viem";
import type { BandData } from "@/hooks/useOraclePriceHistory";
import type { VolumeProfileBin, VolumeProfilePeriod } from "@/hooks/useVolumeProfile";

/** Minimal type for CanvasRenderingTarget2D (from fancy-canvas, transitive dep of lightweight-charts) */
interface CanvasDrawTarget {
  useMediaCoordinateSpace(callback: (args: {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
  }) => void): void;
}

// ---------------------------------------------------------------
// Liquidation zone primitive — draws a filled rectangle between
// two horizontal price levels on the chart canvas
// ---------------------------------------------------------------

class LiquidationZonePrimitive implements ISeriesPrimitive<Time> {
  private _upper = 0;
  private _lower = 0;
  private _fillColor: string;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate?: () => void;
  private _paneViews: IPrimitivePaneView[];

  constructor(fillColor = "rgba(239, 68, 68, 0.08)") {
    this._fillColor = fillColor;
    this._paneViews = [
      { zOrder: () => "bottom" as const, renderer: () => this._renderer() },
    ];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._series = null;
    this._requestUpdate = undefined;
  }

  paneViews() {
    return this._paneViews;
  }

  update(upper: number, lower: number) {
    this._upper = upper;
    this._lower = lower;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  private _renderer(): IPrimitivePaneRenderer | null {
    const series = this._series;
    if (!series || !this._upper || !this._lower) return null;

    const upper = this._upper;
    const lower = this._lower;
    const fillColor = this._fillColor;

    return {
      draw(target: CanvasDrawTarget) {
        const yUpper = series.priceToCoordinate(upper);
        const yLower = series.priceToCoordinate(lower);
        if (yUpper === null || yLower === null) return;

        target.useMediaCoordinateSpace(
          ({
            context,
            mediaSize,
          }: {
            context: CanvasRenderingContext2D;
            mediaSize: { width: number; height: number };
          }) => {
            const top = Math.min(yUpper, yLower);
            const h = Math.abs(yLower - yUpper);
            const w = mediaSize.width;

            // 1. Draw solid faint background fill
            context.fillStyle = fillColor;
            context.fillRect(0, top, w, h);

            // 2. Draw diagonal stripes
            context.save();
            context.beginPath();
            context.rect(0, top, w, h);
            context.clip();

            context.lineWidth = 2;
            context.strokeStyle = "rgba(239, 68, 68, 0.15)";

            // spacing between stripes
            const spacing = 15;
            // Draw diagonal lines starting from bottom left going top right
            // We need to cover the bounding box range
            for (let i = -h; i < w + h; i += spacing) {
              context.beginPath();
              context.moveTo(i, top + h);
              context.lineTo(i + h, top);
              context.stroke();
            }
            context.restore();

            // 3. Draw text label centered "LIQUIDATION ZONE"
            if (h > 14) { // only if enough height room
              context.save();
              context.font = "bold 10px Inter, sans-serif";
              context.fillStyle = "rgba(239, 68, 68, 0.8)";
              context.textAlign = "center";
              context.textBaseline = "middle";
              const textY = top + h / 2;
              context.fillText("LIQUIDATION ZONE", w / 2, textY);
              context.restore();
            }
          },
        );
      },
    };
  }
}

// ---------------------------------------------------------------
// Collateral bands primitive — draws horizontal bars on the chart
// ---------------------------------------------------------------

class CollateralBandsPrimitive implements ISeriesPrimitive<Time> {
  private _bands: BandData[] = [];
  private _activeBand?: number;
  private _maxUsd = 0;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _paneViews: IPrimitivePaneView[];
  private _requestUpdate?: () => void;

  constructor() {
    this._paneViews = [
      { zOrder: () => "top" as const, renderer: () => this._renderer() },
    ];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._series = null;
    this._requestUpdate = undefined;
  }

  paneViews() {
    return this._paneViews;
  }

  update(bands: BandData[] = [], activeBand?: number, maxUsd = 0) {
    this._bands = bands;
    this._activeBand = activeBand;
    this._maxUsd = maxUsd;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  private _renderer(): IPrimitivePaneRenderer | null {
    const series = this._series;
    if (!series || this._bands.length === 0) return null;

    const bands = this._bands;
    const activeBand = this._activeBand;
    const maxUsd = this._maxUsd;

    return {
      draw(target: CanvasDrawTarget) {
        target.useMediaCoordinateSpace(
          ({
            context,
            mediaSize,
          }: {
            context: CanvasRenderingContext2D;
            mediaSize: { width: number; height: number };
          }) => {
            const barMaxW = 80;
            const rightEdge = mediaSize.width;

            context.save();
            context.lineWidth = 1;

            bands.forEach((band) => {
              const yTop = series.priceToCoordinate(band.pUp);
              const yBot = series.priceToCoordinate(band.pDown);
              if (yTop === null || yBot === null) return;

              const top = Math.min(yTop, yBot);
              const h = Math.abs(yBot - yTop);
              const barH = Math.max(h, 1);

              const fraction = maxUsd > 0 ? band.collateralUsd / maxUsd : 0;
              const w = Math.max(fraction * barMaxW, 1);
              const leftEdge = rightEdge - w;

              const isActive = band.n === activeBand;

              // 1. Draw full bar in amber gradient
              const grad = context.createLinearGradient(leftEdge, 0, rightEdge, 0);
              if (isActive) {
                grad.addColorStop(0, "rgba(245, 158, 11, 1)");
                grad.addColorStop(1, "rgba(245, 158, 11, 0.4)");
              } else {
                grad.addColorStop(0, "rgba(245, 158, 11, 0.8)");
                grad.addColorStop(1, "rgba(245, 158, 11, 0.2)");
              }
              context.globalAlpha = isActive ? 1.0 : 0.6;
              context.fillStyle = grad;
              context.beginPath();
              if (typeof context.roundRect === "function") {
                context.roundRect(leftEdge, top, w, barH, [4, 0, 0, 4]);
              } else {
                context.rect(leftEdge, top, w, barH);
              }
              context.fill();

              // 2. Overlay horizontal stripes on stablecoin (crvUSD) portion
              const midPrice = Math.sqrt(band.pUp * band.pDown);
              const collNum = Number(BigInt(band.collateral)) / 1e18;
              const stableNum = Number(BigInt(band.stablecoin)) / 1e18;
              const collUsd = collNum * midPrice;
              const stableUsd = stableNum;
              const totalUsd = collUsd + stableUsd;
              const stableFrac = totalUsd > 0 ? stableUsd / totalUsd : 0;

              if (stableFrac > 0) {
                const stableW = w * stableFrac;
                context.save();
                context.beginPath();
                context.rect(leftEdge, top, stableW, barH);
                context.clip();

                context.strokeStyle = isActive
                  ? "rgba(0, 0, 0, 0.25)"
                  : "rgba(0, 0, 0, 0.15)";
                context.lineWidth = 1;
                context.globalAlpha = 1.0;
                const spacing = 3;
                for (let y = top + spacing; y < top + barH; y += spacing) {
                  context.beginPath();
                  context.moveTo(leftEdge, y);
                  context.lineTo(leftEdge + stableW, y);
                  context.stroke();
                }
                context.restore();
              }

              // 3. Outer border
              context.globalAlpha = isActive ? 1.0 : 0.2;
              context.strokeStyle = isActive ? "rgba(245, 158, 11, 0.9)" : "rgba(245, 158, 11, 0.5)";
              context.lineWidth = 1;
              context.beginPath();
              if (typeof context.roundRect === "function") {
                context.roundRect(leftEdge, top, w, barH, [4, 0, 0, 4]);
              } else {
                context.rect(leftEdge, top, w, barH);
              }
              context.stroke();
            });

            context.restore();
          },
        );
      },
    };
  }
}

// ---------------------------------------------------------------
// Volume profile primitive — draws horizontal bars from LEFT edge
// ---------------------------------------------------------------

class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  private _bins: VolumeProfileBin[] = [];
  private _poc = 0;
  private _vah = 0;
  private _val = 0;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _paneViews: IPrimitivePaneView[];
  private _requestUpdate?: () => void;

  constructor() {
    this._paneViews = [
      { zOrder: () => "top" as const, renderer: () => this._renderer() },
    ];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._series = null;
    this._requestUpdate = undefined;
  }

  paneViews() {
    return this._paneViews;
  }

  update(bins: VolumeProfileBin[] = [], poc = 0, vah = 0, val = 0) {
    this._bins = bins;
    this._poc = poc;
    this._vah = vah;
    this._val = val;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  private _renderer(): IPrimitivePaneRenderer | null {
    const series = this._series;
    if (!series || this._bins.length === 0) return null;

    const bins = this._bins;
    const poc = this._poc;
    const vah = this._vah;
    const val = this._val;

    return {
      draw(target: CanvasDrawTarget) {
        target.useMediaCoordinateSpace(
          ({
            context,
            mediaSize,
          }: {
            context: CanvasRenderingContext2D;
            mediaSize: { width: number; height: number };
          }) => {
            const barMaxW = 120;
            const rightMargin = 0; // flush against price axis
            const maxVol = Math.max(...bins.map((b) => b.volume));
            if (maxVol <= 0) return;

            // Compute bin height from price spacing
            const sortedPrices = bins.map((b) => b.price).sort((a, b) => a - b);
            const binWidth =
              sortedPrices.length > 1
                ? sortedPrices[1] - sortedPrices[0]
                : 0.01;

            const chartRight = mediaSize.width - rightMargin;

            context.save();

            // Draw bars — anchored to right edge, extending leftward
            bins.forEach((bin) => {
              const yCenter = series.priceToCoordinate(bin.price);
              if (yCenter === null) return;

              const yTop = series.priceToCoordinate(bin.price + binWidth / 2);
              const yBot = series.priceToCoordinate(bin.price - binWidth / 2);
              if (yTop === null || yBot === null) return;

              const top = Math.min(yTop, yBot);
              const h = Math.max(Math.abs(yBot - yTop), 1);
              const fraction = bin.volume / maxVol;
              const w = Math.max(fraction * barMaxW, 1);

              const isPoc = Math.abs(bin.price - poc) < binWidth / 2;

              if (isPoc) {
                context.fillStyle = "rgba(147, 130, 220, 0.45)";
                context.strokeStyle = "rgba(147, 130, 220, 0.7)";
              } else {
                context.fillStyle = "rgba(147, 130, 220, 0.15)";
                context.strokeStyle = "rgba(147, 130, 220, 0.3)";
              }

              const barX = chartRight - w;
              context.lineWidth = 1;
              context.beginPath();
              if (typeof context.roundRect === "function") {
                context.roundRect(barX, top, w, h, [4, 0, 0, 4]);
              } else {
                context.rect(barX, top, w, h);
              }
              context.fill();
              context.stroke();
            });

            // Draw VAH/VAL dashed lines (span bar region only)
            context.setLineDash([4, 4]);
            context.lineWidth = 1;

            if (vah > 0) {
              const yVah = series.priceToCoordinate(vah);
              if (yVah !== null) {
                context.strokeStyle = "rgba(147, 130, 220, 0.5)";
                context.beginPath();
                context.moveTo(chartRight - barMaxW - 10, yVah);
                context.lineTo(chartRight, yVah);
                context.stroke();
              }
            }

            if (val > 0) {
              const yVal = series.priceToCoordinate(val);
              if (yVal !== null) {
                context.strokeStyle = "rgba(147, 130, 220, 0.5)";
                context.beginPath();
                context.moveTo(chartRight - barMaxW - 10, yVal);
                context.lineTo(chartRight, yVal);
                context.stroke();
              }
            }

            // POC solid line (span bar region only)
            if (poc > 0) {
              const yPoc = series.priceToCoordinate(poc);
              if (yPoc !== null) {
                context.setLineDash([]);
                context.strokeStyle = "rgba(147, 130, 220, 0.8)";
                context.lineWidth = 1.5;
                context.beginPath();
                context.moveTo(chartRight - barMaxW - 10, yPoc);
                context.lineTo(chartRight, yPoc);
                context.stroke();
              }
            }

            context.restore();
          },
        );
      },
    };
  }
}

// ---------------------------------------------------------------
// Price formatting
// ---------------------------------------------------------------

function formatPrice(price: number): string {
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}

// ---------------------------------------------------------------
// PriceChart component
// ---------------------------------------------------------------

interface PriceChartProps {
  vaultName: string;
  vaultLogo?: string | null;
  symbol: string;
  priceData?: { time: number; value: number }[];
  priceSymbol?: string;
  currentOraclePrice?: number | null;
  liquidationPriceUpper?: number;
  liquidationPriceLower?: number;
  bands?: BandData[];
  activeBand?: number;
  showLiquidationZone?: boolean;
  previewLiqUpper?: number;
  previewLiqLower?: number;
  height?: number;
  // Alt token toggle
  altPriceData?: { time: number; value: number }[];
  altSymbol?: string;
  // Price per share history (for VP bin conversion to cvxCRV)
  pricePerShareData?: { time: number; value: number }[];
  // Volume profile
  volumeProfileBins?: VolumeProfileBin[];
  volumeProfilePoc?: number;
  volumeProfileVah?: number;
  volumeProfileVal?: number;
  volumeProfilePeriod?: VolumeProfilePeriod;
  onVolumeProfilePeriodChange?: (period: VolumeProfilePeriod) => void;
}

export function PriceChart({
  vaultName,
  vaultLogo,
  symbol,
  priceData,
  priceSymbol,
  altPriceData,
  altSymbol,
  currentOraclePrice,
  liquidationPriceUpper,
  liquidationPriceLower,
  bands,
  activeBand,
  showLiquidationZone = true,
  previewLiqUpper,
  previewLiqLower,
  height = 320,
  pricePerShareData,
  volumeProfileBins,
  volumeProfilePoc,
  volumeProfileVah,
  volumeProfileVal,
  volumeProfilePeriod = "30d",
  onVolumeProfilePeriodChange,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const oracleSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const zonePrimitiveRef = useRef<LiquidationZonePrimitive | null>(null);
  const bandsPrimitiveRef = useRef<CollateralBandsPrimitive | null>(null);
  const vpPrimitiveRef = useRef<VolumeProfilePrimitive | null>(null);
  const priceLinesRef = useRef<ReturnType<ISeriesApi<"Area">["createPriceLine"]>[]>([]);
  const accentColorRef = useRef("#f59e0b");
  const focusPricesRef = useRef<number[]>([]);
  const showBandsRef = useRef(false);
  const bandsDataRef = useRef<BandData[] | undefined>(undefined);
  const [showAlt, setShowAlt] = useState(false);
  const [showBands, setShowBands] = useState(false);
  const [showVP, setShowVP] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    price: number;
    time: string;
    visible: boolean;
    bandData?: { n: number; pUp: string; pDown: string; collateral: string; stablecoin: string; usd: string; };
  }>({
    x: 0,
    y: 0,
    price: 0,
    time: "",
    visible: false,
  });

  const activePriceData = showAlt && altPriceData ? altPriceData : priceData;

  // Scale factor to convert yCVXCRV-denominated overlay prices to cvxCRV terms
  const priceScale = useMemo(() => {
    if (!showAlt || !altPriceData?.length || !priceData?.length) return 1;
    const lastAlt = altPriceData[altPriceData.length - 1].value;
    const lastPrimary = priceData[priceData.length - 1].value;
    return lastPrimary > 0 ? lastAlt / lastPrimary : 1;
  }, [showAlt, altPriceData, priceData]);

  // Convert VP data (yCVXCRV prices) to cvxCRV prices when alt view is active
  // VP bins are at yCVXCRV price levels; to get cvxCRV price = yCVXCRV_price / pricePerShare
  // We build a lookup: for each yCVXCRV price level, find the pricePerShare at the time
  // yCVXCRV was at that level, then divide.
  const convertedVP = useMemo(() => {
    if (!showAlt || !volumeProfileBins?.length || !priceData?.length || !pricePerShareData?.length) {
      return { bins: volumeProfileBins, poc: volumeProfilePoc, vah: volumeProfileVah, val: volumeProfileVal };
    }

    // Build a sorted array of (yCVXCRV_price, pricePerShare) from synced time series
    // priceData and pricePerShareData share timestamps from R2
    const ppsMap = new Map<number, number>();
    for (const p of pricePerShareData) ppsMap.set(p.time, p.value);

    const priceToPps: { price: number; pps: number }[] = [];
    for (const p of priceData) {
      const pps = ppsMap.get(p.time);
      if (pps && pps > 0) priceToPps.push({ price: p.value, pps });
    }
    priceToPps.sort((a, b) => a.price - b.price);

    if (priceToPps.length === 0) {
      return { bins: volumeProfileBins, poc: volumeProfilePoc, vah: volumeProfileVah, val: volumeProfileVal };
    }

    // Binary search for nearest yCVXCRV price → get pricePerShare
    const findPps = (targetPrice: number): number => {
      let lo = 0, hi = priceToPps.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (priceToPps[mid].price < targetPrice) lo = mid + 1;
        else hi = mid;
      }
      // Check neighbors for closest match
      if (lo > 0 && Math.abs(priceToPps[lo - 1].price - targetPrice) < Math.abs(priceToPps[lo].price - targetPrice)) {
        return priceToPps[lo - 1].pps;
      }
      return priceToPps[lo].pps;
    };

    const convert = (ycvxcrvPrice: number) => {
      if (!ycvxcrvPrice) return ycvxcrvPrice;
      return ycvxcrvPrice / findPps(ycvxcrvPrice);
    };

    return {
      bins: volumeProfileBins.map((b) => ({ ...b, price: convert(b.price) })),
      poc: volumeProfilePoc != null ? convert(volumeProfilePoc) : volumeProfilePoc,
      vah: volumeProfileVah != null ? convert(volumeProfileVah) : volumeProfileVah,
      val: volumeProfileVal != null ? convert(volumeProfileVal) : volumeProfileVal,
    };
  }, [showAlt, volumeProfileBins, volumeProfilePoc, volumeProfileVah, volumeProfileVal, priceData, pricePerShareData]);

  const hasBands = bands && bands.length > 0;
  const maxBandUsd = hasBands
    ? Math.max(...bands.map((b) => b.collateralUsd))
    : 0;

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const cs = getComputedStyle(document.documentElement);
    const textColor =
      cs.getPropertyValue("--muted-foreground").trim() || "#666";
    const borderColor = cs.getPropertyValue("--border").trim() || "#222";
    const accentColor = cs.getPropertyValue("--accent").trim() || "#f59e0b";
    accentColorRef.current = accentColor;

    const chart = createChart(containerRef.current, {
      localization: {
        priceFormatter: (price: number) => {
          if (price < 0) return "";
          return formatPrice(price);
        },
      },
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
      rightPriceScale: {
        borderColor,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor,
        timeVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal, // Detaches Y-axis from the line
        horzLine: { color: textColor, labelBackgroundColor: "#1a1a1a" },
        vertLine: { color: textColor, labelBackgroundColor: "#1a1a1a" },
      },
      handleScroll: { vertTouchDrag: false },
    });

    chartRef.current = chart;

    const oracleSeries = chart.addSeries(AreaSeries, {
      lineColor: accentColor,
      topColor: `${accentColor}40`, // 25% opacity
      bottomColor: `${accentColor}00`, // 0% opacity
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      // Pin Y-axis at 0 so liquidation zone is visible relative to price
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const orig = original();
        if (!orig) return orig;

        return {
          priceRange: {
            minValue: 0,
            maxValue: orig.priceRange.maxValue,
          },
        };
      },
    });
    oracleSeriesRef.current = oracleSeries;

    // Attach liquidation zone primitive
    const zonePrimitive = new LiquidationZonePrimitive();
    oracleSeries.attachPrimitive(zonePrimitive);
    zonePrimitiveRef.current = zonePrimitive;

    // Attach collateral bands primitive
    const bandsPrimitive = new CollateralBandsPrimitive();
    oracleSeries.attachPrimitive(bandsPrimitive);
    bandsPrimitiveRef.current = bandsPrimitive;

    // Attach volume profile primitive
    const vpPrimitive = new VolumeProfilePrimitive();
    oracleSeries.attachPrimitive(vpPrimitive);
    vpPrimitiveRef.current = vpPrimitive;

    // Tooltip Sync
    chart.subscribeCrosshairMove((param) => {
      const container = containerRef.current;
      if (
        !container ||
        param.point === undefined ||
        param.point.x < 0 ||
        param.point.x > container.clientWidth ||
        param.point.y < 0 ||
        param.point.y > container.clientHeight
      ) {
        setTooltip((prev) => ({ ...prev, visible: false }));
        return;
      }

      // Detect band hover
      let hoveredBand: { n: number; pUp: string; pDown: string; collateral: string; stablecoin: string; usd: string } | undefined = undefined;
      const rightEdge = container.clientWidth;

      // If bands are active, check if the crosshair's current price intersects any band's boundaries
      if (showBandsRef.current && bandsDataRef.current && bandsDataRef.current.length > 0) {
        const currentBands = bandsDataRef.current;
        const hoveredPrice = oracleSeries.coordinateToPrice(param.point.y);
        if (hoveredPrice !== null) {
          const band = currentBands.find((b) => hoveredPrice >= b.pDown && hoveredPrice <= b.pUp);
          if (band) {
            hoveredBand = {
              n: band.n,
              pUp: band.pUp.toLocaleString(undefined, { maximumFractionDigits: 4 }),
              pDown: band.pDown.toLocaleString(undefined, { maximumFractionDigits: 4 }),
              collateral: Number(formatUnits(band.collateral, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
              stablecoin: Number(formatUnits(band.stablecoin, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }),
              usd: band.collateralUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }),
            };
          }
        }
      }

      const data = param.seriesData.get(oracleSeries) as AreaData<Time> | WhitespaceData<Time> | undefined;
      const priceValue = data && "value" in data ? data.value : undefined;
      const hasData = priceValue !== undefined && !!param.time;

      if (!hasData && !hoveredBand) {
        setTooltip((prev) => ({ ...prev, visible: false }));
        return;
      }

      // Format time (assuming unix timestamp from backend)
      let dateStr = "";
      if (hasData) {
        dateStr = new Date((param.time as number) * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }

      // Offset tooltip slightly
      const toolTipWidth = 120;
      const toolTipHeight = hoveredBand ? 90 : 40;
      const toolTipMargin = 12;

      let left = param.point.x + toolTipMargin;
      let top = param.point.y - toolTipHeight - toolTipMargin;

      if (left + toolTipWidth > rightEdge) {
        left = param.point.x - toolTipMargin - toolTipWidth;
      }
      if (top < 0) {
        top = param.point.y + toolTipMargin;
      }

      setTooltip({
        x: left,
        y: top,
        price: priceValue ?? 0,
        time: dateStr,
        visible: true,
        bandData: hoveredBand,
      });
    });

    // Handle resize
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth > 0 && clientHeight > 0) {
          chart.applyOptions({
            width: clientWidth,
            height: clientHeight,
          });
        }
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      oracleSeriesRef.current = null;
      zonePrimitiveRef.current = null;
      bandsPrimitiveRef.current = null;
      vpPrimitiveRef.current = null;
    };
  }, []); // Run once on mount

  // Update chart data
  useEffect(() => {
    const chart = chartRef.current;
    const oracleSeries = oracleSeriesRef.current;
    const zonePrimitive = zonePrimitiveRef.current;
    const bandsPrimitive = bandsPrimitiveRef.current;
    if (!chart || !oracleSeries) return;

    // Sync refs for crosshair callback (fixes stale closure)
    showBandsRef.current = showBands;

    if (!activePriceData || activePriceData.length === 0) return;

    // Set oracle price data
    const oracleData: AreaData[] = activePriceData.map((d) => ({
      time: d.time as Time,
      value: d.value,
    }));

    // Pad data with whitespace points to extend hoverable area to the right
    const paddedData: (AreaData<Time> | WhitespaceData<Time>)[] = [...oracleData];
    const numPaddingPoints = 15; // Extends the chart roughly 15 days to the right to allow hover space
    let lastTime = Math.floor(Date.now() / 1000); // Default to now if no data
    if (paddedData.length > 0) {
      lastTime = paddedData[paddedData.length - 1].time as number;
    }

    for (let i = 1; i <= numPaddingPoints; i++) {
      paddedData.push({ time: (lastTime + i * 86400) as Time });
    }

    oracleSeries.setData(paddedData);

    // Effective liquidation prices — preview overrides current when available
    // Apply priceScale to convert from yCVXCRV to cvxCRV terms when alt view is active
    const s = priceScale;
    const effectiveUpper = (previewLiqUpper ?? liquidationPriceUpper) !== undefined
      ? ((previewLiqUpper ?? liquidationPriceUpper) as number) * s
      : undefined;
    const effectiveLower = (previewLiqLower ?? liquidationPriceLower) !== undefined
      ? ((previewLiqLower ?? liquidationPriceLower) as number) * s
      : undefined;

    // Update liquidation zone fill
    if (
      zonePrimitive &&
      showLiquidationZone &&
      effectiveUpper !== undefined &&
      effectiveLower !== undefined
    ) {
      zonePrimitive.update(effectiveUpper, effectiveLower);
    } else if (zonePrimitive) {
      zonePrimitive.update(0, 0);
    }

    // Update collateral bands primitive
    // When preview liq prices are active, shift band positions proportionally
    if (bandsPrimitive) {
      if (showBands && bands && bands.length > 0) {
        let displayBands = bands;

        // Shift band positions when previewing new liq range
        if (previewLiqUpper && previewLiqLower && liquidationPriceUpper && liquidationPriceLower) {
          const currentUpper = liquidationPriceUpper;
          const currentLower = liquidationPriceLower;
          const currentRange = currentUpper - currentLower;
          const previewRange = previewLiqUpper - previewLiqLower;

          if (currentRange > 0) {
            displayBands = bands.map((band) => ({
              ...band,
              pUp: previewLiqLower + ((band.pUp - currentLower) / currentRange) * previewRange,
              pDown: previewLiqLower + ((band.pDown - currentLower) / currentRange) * previewRange,
            }));
          }
        }

        // Scale band prices for alt token view
        if (s !== 1) {
          displayBands = displayBands.map((band) => ({
            ...band,
            pUp: band.pUp * s,
            pDown: band.pDown * s,
          }));
        }

        bandsDataRef.current = displayBands;
        bandsPrimitive.update(displayBands, activeBand, maxBandUsd);
      } else {
        bandsDataRef.current = bands;
        bandsPrimitive.update([]);
      }
    }

    // Update volume profile primitive (uses convertedVP for alt view)
    const vpPrimitive = vpPrimitiveRef.current;
    if (vpPrimitive) {
      if (showVP && convertedVP.bins && convertedVP.bins.length > 0) {
        vpPrimitive.update(
          convertedVP.bins,
          convertedVP.poc ?? 0,
          convertedVP.vah ?? 0,
          convertedVP.val ?? 0,
        );
      } else {
        vpPrimitive.update([]);
      }
    }

    // Remove old price lines before creating new ones
    for (const pl of priceLinesRef.current) {
      oracleSeries.removePriceLine(pl);
    }
    priceLinesRef.current = [];

    const accent = accentColorRef.current;

    // Oracle price — accent-colored label on Y-axis
    const scaledOraclePrice = currentOraclePrice ? currentOraclePrice * s : undefined;
    if (scaledOraclePrice) {
      priceLinesRef.current.push(
        oracleSeries.createPriceLine({
          price: scaledOraclePrice,
          color: "transparent",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelColor: accent,
          axisLabelVisible: true,
          title: "",
        }),
      );
    }

    // Liquidation threshold — red dashed with Y-axis label
    if (showLiquidationZone && effectiveUpper !== undefined) {
      priceLinesRef.current.push(
        oracleSeries.createPriceLine({
          price: effectiveUpper,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        }),
      );
    }

    // Liquidation lower — darker red dashed with Y-axis label
    if (showLiquidationZone && effectiveLower !== undefined) {
      priceLinesRef.current.push(
        oracleSeries.createPriceLine({
          price: effectiveLower,
          color: "#b91c1c",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        }),
      );
    }

    // Update focus prices for autoscale constraint
    const focus: number[] = [];
    if (scaledOraclePrice) focus.push(scaledOraclePrice);
    if (effectiveUpper !== undefined) focus.push(effectiveUpper);
    if (effectiveLower !== undefined) focus.push(effectiveLower);
    focusPricesRef.current = focus;

    chart.timeScale().fitContent();
  }, [
    activePriceData,
    priceScale,
    currentOraclePrice,
    liquidationPriceUpper,
    liquidationPriceLower,
    showLiquidationZone,
    previewLiqUpper,
    previewLiqLower,
    showBands,
    bands,
    activeBand,
    maxBandUsd,
    showVP,
    convertedVP,
  ]);

  return (
    <div
      className={cn(
        "relative w-full",
        isFullscreen && "fixed inset-0 z-50 bg-[var(--background)] p-4 flex flex-col animate-in fade-in duration-200"
      )}
    >
      {/* Chart container */}
      <div className={cn("relative w-full mx-auto min-w-0", isFullscreen ? "flex-1 flex flex-col" : "max-w-[1400px]")}>
        <div
          ref={containerRef}
          className={cn("border border-[var(--border)] rounded-lg w-full relative", isFullscreen ? "flex-1" : "h-[400px] sm:h-[450px]")}
        >
          {/* Overlay Header + Actions (single row to prevent overlap) */}
          <div className="absolute top-3 left-4 right-20 z-20 flex items-center gap-2 pointer-events-none">
            {/* Vault Header — left side */}
            <div className="flex items-center gap-2 bg-[var(--background)]/40 px-3 py-1.5 rounded-lg backdrop-blur-sm border border-[var(--border)]/50 shadow-sm mr-auto shrink-0">
              {vaultLogo && (
                <Image
                  src={vaultLogo}
                  alt={vaultName}
                  width={18}
                  height={18}
                  className="rounded-full bg-black/20"
                />
              )}
              <div className="flex items-baseline gap-1.5">
                <h1 className="text-sm font-semibold tracking-tight text-[var(--foreground)] drop-shadow-md">
                  {vaultName}
                </h1>
                <span className="text-[10px] font-medium text-[var(--accent)] drop-shadow-sm uppercase">
                  LlamaLend
                </span>
              </div>
              {altPriceData && altSymbol && (
                <div className="flex items-center rounded overflow-hidden border border-[var(--border)]/50 shadow-sm pointer-events-auto">
                  <button
                    type="button"
                    onClick={() => setShowAlt(false)}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 transition-all",
                      !showAlt
                        ? "bg-[var(--foreground)] text-[var(--background)] font-medium"
                        : "bg-[var(--background)]/60 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    )}
                  >
                    {priceSymbol ?? symbol}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAlt(true)}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 transition-all",
                      showAlt
                        ? "bg-[var(--foreground)] text-[var(--background)] font-medium"
                        : "bg-[var(--background)]/60 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    )}
                  >
                    {altSymbol}
                  </button>
                </div>
              )}
            </div>

            {/* Action buttons — right side */}
            <div className="flex items-center gap-1 pointer-events-auto">
              {volumeProfileBins && volumeProfileBins.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowVP(!showVP)}
                    className={cn(
                      "text-[10px] font-medium px-1.5 py-1 rounded flex items-center justify-center transition-all shadow-sm backdrop-blur-md border",
                      showVP
                        ? "bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)] hover:bg-[var(--foreground)]/90"
                        : "bg-[var(--background)]/80 text-[var(--foreground)] border-[var(--border)] hover:bg-[var(--accent)] hover:text-white"
                    )}
                  >
                    VP
                  </button>
                  {showVP && onVolumeProfilePeriodChange && (
                    <div className="flex items-center rounded overflow-hidden border border-[var(--border)] shadow-sm backdrop-blur-md">
                      {(["30d", "90d", "all"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => onVolumeProfilePeriodChange(p)}
                          className={cn(
                            "text-[10px] px-1 py-1 transition-all",
                            volumeProfilePeriod === p
                              ? "bg-[var(--foreground)] text-[var(--background)] font-medium"
                              : "bg-[var(--background)]/80 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          )}
                        >
                          {p === "all" ? "All" : p}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {hasBands && (
                <button
                  type="button"
                  onClick={() => setShowBands(!showBands)}
                  className={cn(
                    "text-[10px] font-medium px-1.5 py-1 rounded flex items-center justify-center transition-all shadow-sm backdrop-blur-md border",
                    showBands
                      ? "bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)] hover:bg-[var(--foreground)]/90"
                      : "bg-[var(--background)]/80 text-[var(--foreground)] border-[var(--border)] hover:bg-[var(--accent)] hover:text-white"
                  )}
                >
                  Bands
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  if (chartRef.current) {
                    chartRef.current.timeScale().fitContent();
                    chartRef.current.priceScale("right").applyOptions({ autoScale: true });
                  }
                }}
                className="text-[10px] px-1.5 py-1 rounded flex items-center justify-center transition-all shadow-sm backdrop-blur-md bg-[var(--background)]/80 text-[var(--foreground)] border border-[var(--border)] hover:bg-[var(--accent)] hover:text-white"
                title="Reset Chart"
              >
                <RefreshCcw size={12} />
              </button>

              <button
                type="button"
                onClick={() => setIsFullscreen(!isFullscreen)}
                className="text-[10px] px-1.5 py-1 rounded flex items-center justify-center transition-all shadow-sm backdrop-blur-md bg-[var(--background)]/80 text-[var(--foreground)] border border-[var(--border)] hover:bg-[var(--accent)] hover:text-white"
                title={isFullscreen ? "Minimize" : "Maximize"}
              >
                {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </div>
          </div>
        </div>
        {/* Custom HTML Tooltip Overlaid on Chart */}
        <div
          className={cn(
            "absolute z-10 pointer-events-none transition-opacity duration-100 shadow-lg border border-[var(--border)] bg-[var(--background)]/90 backdrop-blur-md rounded-md px-2.5 py-2 text-[11px]",
            tooltip.visible ? "opacity-100" : "opacity-0"
          )}
          style={{
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          {tooltip.time && (
            <div className="text-[var(--muted-foreground)] text-[10px]">{tooltip.time}</div>
          )}
          {tooltip.price > 0 && (
            <div className="font-mono text-[var(--foreground)] font-medium">
              ${formatPrice(tooltip.price)}
            </div>
          )}

          {tooltip.bandData && (
            <div className={cn(
              "space-y-0.5",
              (tooltip.time || tooltip.price > 0) ? "mt-1.5 pt-1.5 border-t border-[var(--border)]" : ""
            )}>
              <div className="text-[var(--accent)] font-medium text-[10px] mb-1">Band {tooltip.bandData.n} &middot; ${tooltip.bandData.pDown}–${tooltip.bandData.pUp}</div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--muted-foreground)]">{symbol}</span>
                <span>{tooltip.bandData.collateral}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--muted-foreground)]">crvUSD</span>
                <span>{tooltip.bandData.stablecoin}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 w-full max-w-[1400px] mx-auto text-xs text-[var(--muted-foreground)]">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 bg-[var(--accent)] rounded-full" />
          <span>Oracle Price</span>
        </div>
        {showVP && convertedVP.poc != null && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-2.5 bg-purple-400/30 rounded-sm border border-purple-400/50" />
            <span>Vol Profile</span>
            <span className="text-[var(--foreground)] tabular-nums ml-0.5">POC {formatPrice(convertedVP.poc)}</span>
          </div>
        )}
        {showLiquidationZone && (liquidationPriceUpper !== undefined || previewLiqUpper !== undefined) && (
          <>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-px border-t border-dashed border-red-500" />
              <span>Liq. range</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-2.5 bg-red-500/10 rounded-sm border border-red-500/30" />
              <span>Liq. zone</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
