"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useAccount, useBalance, useBlockNumber, useGasPrice, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { MaxButton } from "@/components/MaxButton";
import { ArrowUpRight, ExternalLink, Search, Route, RouteOff, Copy, ChevronDown, ChevronRight, Check, X, Clock, ArrowRightLeft, HeartPulse, Shield, Wallet, Banknote, Percent, TrendingUp, Info, Coins, Gift } from "lucide-react";
import { RouteDisplay } from "@/components/RouteDisplay";
import { SlippageModal } from "@/components/SlippageModal";
import { SimulationModal } from "@/components/SimulationModal";
import { ApprovalCard } from "@/components/ApprovalCard";
import { LoadingDots } from "@/components/LoadingDots";

// Parse Enso API errors into user-friendly messages
function parseQuoteError(error: Error | null): string {
  if (!error) return "Failed to get quote";
  const msg = error.message || "";

  // Amount too large/out of range
  if (msg.includes("amountIn") && msg.includes("acceptable range")) {
    return "Amount too large to quote - try a smaller amount";
  }
  // Insufficient liquidity
  if (msg.includes("insufficient liquidity") || msg.includes("no route found")) {
    return "No route available - insufficient liquidity";
  }
  // Rate limit
  if (msg.includes("rate limit") || msg.includes("429")) {
    return "Too many requests - please wait a moment";
  }
  // Network/timeout errors
  if (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch")) {
    return "Network error - please try again";
  }
  // Generic API error - show shortened version
  if (msg.startsWith("API Error:")) {
    return "Quote unavailable - try a different amount";
  }

  return "Failed to get quote";
}

import { ContractExplorer, useContractExplorer, type ExplorerContract } from "@/components/ContractExplorer";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { sanitizeAmount } from "@/lib/sanitize";
import { useSettings } from "@/hooks/useSettings";
import { useMerklRewards, useMerklOpportunities } from "@/hooks/useMerklRewards";
import { formatUsd } from "@/lib/utils";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Logo } from "@/components/Logo";
import { useCurveLendingVault, formatCurveVaultData } from "@/hooks/useCurveLendingData";
import { useCurveLendingPosition, formatHealth } from "@/hooks/useCurveLendingPosition";
import { useCurveMarketRates } from "@/hooks/useCurveMarketRates";
import { buildLendingPositionDisplay } from "@/lib/lending";
import { useYearnVault, formatYearnVaultData } from "@/hooks/useYearnVault";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useCvxCrvPrice } from "@/hooks/useCvxCrvPrice";
import { usePricePerShare } from "@/hooks/usePricePerShare";
import { useVaultCache } from "@/hooks/useVaultCache";
import { useVaultActions } from "@/hooks/useVaultActions";
import { useZapQuote } from "@/hooks/useZapQuote";
import { useZapActions } from "@/hooks/useZapActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useClearOnNavigation } from "@/hooks/useClearOnNavigation";
import { DEFAULT_ETH_TOKEN } from "@/hooks/useEnsoTokens";
import { TokenSelector } from "@/components/TokenSelector";
import { ETH_ADDRESS } from "@/lib/enso";
import { getMaxEthAmount } from "@/lib/eth-gas";
import { CHAINLINK_ETH_USD } from "@/config/addresses";
import { getVault, getVaultByAddress, TOKENS, VAULT_UNDERLYING_TOKENS, VAULTS, EXTERNAL_VAULT_TOKENS, CURVE_CONTROLLERS, CURVE_SAVINGS } from "@/config/vaults";
import { CollateralModal, LendingInterface } from "@/components/lending";
import type { EnsoToken, ZapDirection, SimulationAssetChange } from "@/types/enso";
import {
  trackVaultView,
  trackDepositInitiated,
  trackDepositSuccess,
  trackWithdrawInitiated,
  trackWithdrawSuccess,
  trackApprovalInitiated,
  trackApprovalSuccess,
  trackTransactionError,
  trackTransactionCancelled,
  trackZapInitiated,
  trackZapSuccess,
  isUserRejection,
} from "@/lib/analytics";
import { toast } from "sonner";

export function VaultPageContent({ id }: { id: string }) {
  const vault = getVault(id);
  const router = useRouter();
  const [vaultSelectorOpen, setVaultSelectorOpen] = useState(false);
  const vaultSelectorRef = useRef<HTMLDivElement>(null);

  // Get all visible vaults for the selector (always include current vault)
  const normalizedId = id.toLowerCase();
  const availableVaults = Object.values(VAULTS).filter(
    (v) =>
      v.id === normalizedId ||
      (!v.hidden && v.address !== "0x0000000000000000000000000000000000000000")
  );

  // Create explorer contracts list for the contract explorer dropdown
  const explorerContracts: ExplorerContract[] = availableVaults.map((v) => ({
    address: v.address,
    title: v.name,
    icon: v.logo,
    showFlowTab: v.type === "strategy",
  }));

  // Close vault selector when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (vaultSelectorRef.current && !vaultSelectorRef.current.contains(event.target as Node)) {
        setVaultSelectorOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Check if vault is deployed (has non-zero address)
  const isVaultDeployed = vault?.address && vault.address !== "0x0000000000000000000000000000000000000000";

  // DEBUG: Preview transaction states with granular control
  type DebugTxState = "none" | "deposit-pending" | "deposit-success" | "deposit-reverted" | "withdraw-pending" | "withdraw-success" | "withdraw-reverted" | "zap-in-pending" | "zap-in-success" | "zap-in-reverted" | "zap-out-pending" | "zap-out-success" | "zap-out-reverted";
  const [debugTxState, setDebugTxState] = useState<DebugTxState>("none");
  const debugHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const [debugSimulationResult, setDebugSimulationResult] = useState<{
    success: boolean;
    gasUsed?: number;
    errorMessage?: string;
    tenderlyUrl?: string;
    assetChanges: { type: "send" | "receive"; symbol: string; amount: string; logo?: string; dollarValue?: number }[];
  } | null>(null);

  // DEBUG: Draggable panel position (persisted to localStorage)
  const [debugPanelPos, setDebugPanelPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [debugMinimized, setDebugMinimized] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("yldfi-vault-tx-preview-minimized") === "true"; } catch { return false; }
  });
  const toggleDebugMinimized = useCallback(() => {
    setDebugMinimized(prev => {
      const next = !prev;
      try { localStorage.setItem("yldfi-vault-tx-preview-minimized", String(next)); } catch {}
      return next;
    });
  }, []);

  // Load saved position on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("yldfi-debug-panel-pos");
      if (saved) {
        setDebugPanelPos(JSON.parse(saved));
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Drag handlers for debug panel
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const panel = (e.target as HTMLElement).closest("[data-debug-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    setIsDragging(true);
  }, []);

  const handleDrag = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const newX = e.clientX - dragOffset.current.x;
    const newY = e.clientY - dragOffset.current.y;
    setDebugPanelPos({ x: newX, y: newY });
  }, [isDragging]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    // Save position to localStorage
    if (debugPanelPos) {
      try {
        localStorage.setItem("yldfi-debug-panel-pos", JSON.stringify(debugPanelPos));
      } catch {
        // localStorage unavailable
      }
    }
  }, [isDragging, debugPanelPos]);

  // Add/remove global mouse listeners for dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleDrag);
      window.addEventListener("mouseup", handleDragEnd);
      return () => {
        window.removeEventListener("mousemove", handleDrag);
        window.removeEventListener("mouseup", handleDragEnd);
      };
    }
  }, [isDragging, handleDrag, handleDragEnd]);
  // Helper to check debug state categories
  const isDebugPending = debugTxState.endsWith("-pending");
  const isDebugSuccess = debugTxState.endsWith("-success");
  const isDebugReverted = debugTxState.endsWith("-reverted");
  const isDebugDeposit = debugTxState.startsWith("deposit-");
  const isDebugWithdraw = debugTxState.startsWith("withdraw-");
  const isDebugZap = debugTxState.startsWith("zap-");
  const isDebugZapIn = debugTxState.startsWith("zap-in-");
  const isDebugZapOut = debugTxState.startsWith("zap-out-");
  // Sample debug tx details (changes based on debug state)
  const debugTxDetails = vault ? (() => {
    if (isDebugDeposit) {
      return {
        fromAmount: "142.24",
        fromSymbol: vault.assetSymbol,
        fromLogo: `/tokens/${vault.assetSymbol.toLowerCase()}.png`,
        toAmount: "138.91",
        toSymbol: vault.symbol,
        toLogo: vault.logo,
      };
    } else if (isDebugWithdraw) {
      return {
        fromAmount: "138.91",
        fromSymbol: vault.symbol,
        fromLogo: vault.logo,
        toAmount: "142.24",
        toSymbol: vault.assetSymbol,
        toLogo: `/tokens/${vault.assetSymbol.toLowerCase()}.png`,
      };
    } else if (isDebugZapIn) {
      return {
        fromAmount: "1.5",
        fromSymbol: "ETH",
        fromLogo: "/tokens/eth.png",
        toAmount: "523.18",
        toSymbol: vault.symbol,
        toLogo: vault.logo,
      };
    } else if (isDebugZapOut) {
      return {
        fromAmount: "523.18",
        fromSymbol: vault.symbol,
        fromLogo: vault.logo,
        toAmount: "1.48",
        toSymbol: "ETH",
        toLogo: "/tokens/eth.png",
      };
    }
    return null;
  })() : null;
  // DEBUG: Auto-cycle through states
  const [debugAutoCycle, setDebugAutoCycle] = useState(false);
  const [debugCycleSpeed, setDebugCycleSpeed] = useState(1500); // ms between transitions
  const debugAllStates: DebugTxState[] = ["none", "deposit-pending", "deposit-success", "deposit-reverted", "withdraw-pending", "withdraw-success", "withdraw-reverted", "zap-in-pending", "zap-in-success", "zap-in-reverted", "zap-out-pending", "zap-out-success", "zap-out-reverted"];
  useEffect(() => {
    if (!debugAutoCycle) return;
    const interval = setInterval(() => {
      setDebugTxState(prev => {
        const currentIndex = debugAllStates.indexOf(prev);
        const nextIndex = (currentIndex + 1) % debugAllStates.length;
        return debugAllStates[nextIndex];
      });
    }, debugCycleSpeed);
    return () => clearInterval(interval);
  }, [debugAutoCycle, debugCycleSpeed]);

  const { isConnected, address: userAddress, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  // Active tab with localStorage persistence
  const [activeTab, setActiveTabState] = useState<"deposit" | "withdraw" | "zap">(() => {
    if (typeof window === "undefined") return "deposit";
    try {
      const saved = localStorage.getItem("yldfi-active-tab");
      if (saved === "deposit" || saved === "withdraw" || saved === "zap") return saved;
    } catch {
      // localStorage unavailable (incognito, disabled, quota exceeded)
    }
    return "deposit";
  });
  const setActiveTab = (tab: "deposit" | "withdraw" | "zap") => {
    setActiveTabState(tab);
    try {
      localStorage.setItem("yldfi-active-tab", tab);
    } catch {
      // localStorage unavailable
    }
  };

  // Contract explorer state (localStorage persisted)
  const { isOpen: explorerOpen, address: explorerAddress, title: explorerTitle, lastUpdated: explorerLastUpdated, icon: explorerIcon, showFlowTab: explorerShowFlowTab, activeTab: explorerActiveTab, openExplorer, switchContract, closeExplorer, setActiveTab: setExplorerActiveTab } = useContractExplorer();
  const [amount, setAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return sanitizeAmount(sessionStorage.getItem(`yldfi-amount-${id}`) ?? ""); } catch { return ""; }
  });
  const setAmount = useCallback((value: string) => {
    const sanitized = sanitizeAmount(value);
    setAmountState(sanitized);
    try {
      if (sanitized) sessionStorage.setItem(`yldfi-amount-${id}`, sanitized);
      else sessionStorage.removeItem(`yldfi-amount-${id}`);
    } catch { /* */ }
  }, [id]);

  // Reset amount when Tenderly network changes (mainnet <-> VNet)
  useEffect(() => {
    const handleNetworkChange = () => {
      setAmount("");
    };
    window.addEventListener("tenderly-network-change", handleNetworkChange);
    return () => window.removeEventListener("tenderly-network-change", handleNetworkChange);
  }, []);

  // Track previous vault id to detect navigation vs refresh
  const prevIdRef = useRef<string | null>(null);

  // Zap state with localStorage persistence (scoped per vault)
  const [zapDirection, setZapDirectionState] = useState<ZapDirection>(() => {
    if (typeof window === "undefined") return "in";
    try {
      const saved = sessionStorage.getItem(`yldfi-zap-direction-${id}`);
      return saved === "out" ? "out" : "in";
    } catch {
      return "in";
    }
  });
  const setZapDirection = (dir: ZapDirection) => {
    setZapDirectionState(dir);
    try {
      sessionStorage.setItem(`yldfi-zap-direction-${id}`, dir);
    } catch {
      // sessionStorage unavailable
    }
  };
  const [zapInputToken, setZapInputTokenState] = useState<EnsoToken | null>(() => {
    if (typeof window === "undefined") return DEFAULT_ETH_TOKEN;
    try {
      const saved = sessionStorage.getItem(`yldfi-zap-input-token-${id}`);
      return saved ? JSON.parse(saved) : DEFAULT_ETH_TOKEN;
    } catch {
      return DEFAULT_ETH_TOKEN;
    }
  });
  const setZapInputToken = (token: EnsoToken | null) => {
    setZapInputTokenState(token);
    try {
      if (token) {
        sessionStorage.setItem(`yldfi-zap-input-token-${id}`, JSON.stringify(token));
      } else {
        sessionStorage.removeItem(`yldfi-zap-input-token-${id}`);
      }
    } catch {
      // sessionStorage unavailable
    }
  };
  const [zapOutputToken, setZapOutputTokenState] = useState<EnsoToken | null>(() => {
    if (typeof window === "undefined") return DEFAULT_ETH_TOKEN;
    try {
      const saved = sessionStorage.getItem(`yldfi-zap-output-token-${id}`);
      return saved ? JSON.parse(saved) : DEFAULT_ETH_TOKEN;
    } catch {
      return DEFAULT_ETH_TOKEN;
    }
  });
  const setZapOutputToken = (token: EnsoToken | null) => {
    setZapOutputTokenState(token);
    try {
      if (token) {
        sessionStorage.setItem(`yldfi-zap-output-token-${id}`, JSON.stringify(token));
      } else {
        sessionStorage.removeItem(`yldfi-zap-output-token-${id}`);
      }
    } catch {
      // sessionStorage unavailable
    }
  };
  const [zapAmount, setZapAmountState] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return sanitizeAmount(sessionStorage.getItem(`yldfi-zap-amount-${id}`) ?? "");
    } catch {
      return "";
    }
  });
  const setZapAmount = useCallback((amount: string) => {
    const sanitized = sanitizeAmount(amount);
    setZapAmountState(sanitized);
    try {
      if (sanitized) {
        sessionStorage.setItem(`yldfi-zap-amount-${id}`, sanitized);
      } else {
        sessionStorage.removeItem(`yldfi-zap-amount-${id}`);
      }
    } catch {
      // sessionStorage unavailable
    }
  }, [id]);

  // Reset state when navigating to a different vault (not on refresh)
  useEffect(() => {
    if (prevIdRef.current !== null && prevIdRef.current !== id) {
      // Navigation to different vault - reset to deposit and zap in
      setActiveTabState("deposit");
      setZapDirectionState("in");
      setAmount("");
      setZapAmountState("");
    }
    prevIdRef.current = id;
  }, [id]);

  // Guard: reset zap input/output tokens if they match the vault or underlying tokens
  // (can happen from stale localStorage values)
  const excludedZapAddresses = useMemo(() => {
    const set = new Set([...VAULT_UNDERLYING_TOKENS.map(a => a.toLowerCase())]);
    if (vault?.address) set.add(vault.address.toLowerCase());
    return set;
  }, [vault?.address]);

  useEffect(() => {
    if (zapInputToken && excludedZapAddresses.has(zapInputToken.address.toLowerCase())) {
      setZapInputToken(DEFAULT_ETH_TOKEN);
    }
  }, [zapInputToken, excludedZapAddresses]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (zapOutputToken && excludedZapAddresses.has(zapOutputToken.address.toLowerCase())) {
      setZapOutputToken(DEFAULT_ETH_TOKEN);
    }
  }, [zapOutputToken, excludedZapAddresses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear form state when navigating away (but preserve on refresh)
  useClearOnNavigation([
    `yldfi-amount-${id}`,
    `yldfi-zap-amount-${id}`,
    `yldfi-zap-direction-${id}`,
    `yldfi-zap-input-token-${id}`,
    `yldfi-zap-output-token-${id}`,
  ]);

  // Debounce zap amount to prevent rate limiting from Enso API (1 req/sec)
  const debouncedZapAmount = useDebouncedValue(zapAmount, 500);
  const {
    slippage: zapSlippage, updateSlippage, showSlippageModal, setShowSlippageModal,
    showSimulationPreview, setShowSimulationPreview, refreshSimulationPreview,
    showSimulationModal, setShowSimulationModal,
  } = useSettings();
  const [showPriceImpactModal, setShowPriceImpactModal] = useState(false);
  const [zapInProgress, setZapInProgress] = useState(false);
  const [priceImpactConfirmText, setPriceImpactConfirmText] = useState("");
  // Route display toggle with localStorage persistence (vault uses different key: yldfi-show-route)
  const [showRoute, setShowRoute] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("yldfi-show-route") === "true";
    } catch {
      return false;
    }
  });
  const toggleRoute = () => {
    const newValue = !showRoute;
    setShowRoute(newValue);
    try {
      localStorage.setItem("yldfi-show-route", String(newValue));
    } catch {
      // localStorage unavailable
    }
  };
  const [isSimulatingPreview, setIsSimulatingPreview] = useState(false);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  // Track if we should skip simulation (already ran from preview mode)
  const [skipSimulationOnConfirm, setSkipSimulationOnConfirm] = useState(false);
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const simulationBlock = useRef<bigint>(0n);

  // Lending interface modal state (kept for backwards compatibility, but page is preferred)
  const [showCollateralModal, setShowCollateralModal] = useState(false);
  const [showLendingInterface, setShowLendingInterface] = useState(false);

  // Handle "Use as Collateral" button click - navigate to lending page
  const handleCollateralClick = () => {
    if (vault) {
      router.push(`/vaults/${vault.id}/lending`);
    }
  };

  // Get current gas price for gas cost calculation
  const { data: gasPrice } = useGasPrice();
  const publicClient = usePublicClient();

  // Chainlink ETH/USD price feed address on mainnet (imported from config/addresses)

  // Handle token selection
  // Zap in: changing input token resets amount (you're changing what you send)
  // Zap out: changing output token does NOT reset amount (you're just changing what you receive)
  const handleZapInputTokenChange = (token: EnsoToken) => {
    setZapInputToken(token);
    setZapAmount(""); // Reset when changing input (zap in)
  };
  const handleZapOutputTokenChange = (token: EnsoToken) => {
    setZapOutputToken(token);
    // Don't reset amount - user is just changing what they want to receive
  };

  // Last transaction result for showing success/error message (stored for potential future UI use)
  const [_lastTxResult, setLastTxResult] = useState<{
    hash: string;
    status: "success" | "reverted";
    type: "deposit" | "withdraw" | "zap";
  } | null>(null);

  // Transaction success animation state - shows green tick briefly after confirmation
  const [showTxSuccess, setShowTxSuccess] = useState<{
    show: boolean;
    type: "deposit" | "withdraw" | "zap";
    hash: string;
  } | null>(null);

  // Transaction reverted state for visual feedback
  const [showTxReverted, setShowTxReverted] = useState<{
    show: boolean;
    type: "deposit" | "withdraw" | "zap";
    hash: string;
  } | null>(null);

  // Pending transaction details for display
  const [pendingTxDetails, setPendingTxDetails] = useState<{
    fromAmount: string;
    fromSymbol: string;
    fromLogo: string;
    toAmount: string;
    toSymbol: string;
    toLogo: string;
  } | null>(null);

  // Helper to set pending tx details for zap transactions
  const setZapPendingDetails = () => {
    if (!zapQuote || !vault) return;
    if (zapDirection === "in") {
      setPendingTxDetails({
        fromAmount: zapAmount ? Number(zapAmount).toFixed(4) : "0",
        fromSymbol: zapInputToken?.symbol ?? "Token",
        fromLogo: zapInputToken?.logoURI ?? "/tokens/unknown.png",
        toAmount: Number(zapQuote.outputAmountFormatted).toFixed(4),
        toSymbol: vault.symbol,
        toLogo: vault.logo,
      });
    } else {
      setPendingTxDetails({
        fromAmount: zapAmount ? Number(zapAmount).toFixed(4) : "0",
        fromSymbol: vault.symbol,
        fromLogo: vault.logo,
        toAmount: Number(zapQuote.outputAmountFormatted).toFixed(4),
        toSymbol: zapOutputToken?.symbol ?? "Token",
        toLogo: zapOutputToken?.logoURI ?? "/tokens/unknown.png",
      });
    }
  };

  // Multi-step transaction state - tracks when approval + deposit/zap should chain automatically
  // When set, shows the multi-step pending UI and auto-executes the next step after approval
  const [pendingMultiStep, setPendingMultiStep] = useState<{
    type: "deposit" | "zap";  // Which flow this is for
    step: 1 | 2;  // 1 = approval, 2 = deposit/swap
    approvalToken: string;  // Token symbol being approved
    spenderName: string;    // Name of spender (e.g., "Enso", "ycvxCRV")
  } | null>(null);

  // Price impact threshold for confirmation (5%)
  const PRICE_IMPACT_CONFIRM_THRESHOLD = 5;



  // Fetch Yearn Kong API data
  const { data: yearnData, isLoading: yearnLoading } = useYearnVault(vault?.address ?? "");
  const yearnVault = formatYearnVaultData(yearnData?.vault, yearnData?.vaultStrategies);

  const displayApyFormatted = yearnVault?.apyFormatted ?? "—"; // Replaced below after vaultCache loads

  // Fetch Curve lending market data (only for vault type)
  const { vault: curveVault } = useCurveLendingVault(
    vault?.type === "vault" ? vault?.address ?? "" : ""
  );
  const curveData = formatCurveVaultData(curveVault);

  // Fetch user's lending position (only for vault type with LlamaLend market)
  const controllerAddress = vault?.address
    ? (CURVE_CONTROLLERS[vault.address as keyof typeof CURVE_CONTROLLERS] as `0x${string}` | undefined)
    : undefined;
  const { position: lendingPosition } = useCurveLendingPosition(
    controllerAddress ? (vault?.address as `0x${string}`) : undefined,
    userAddress
  );
  const onChainRates = useCurveMarketRates(controllerAddress);

  // Merkl rewards earnings
  const { data: merklData } = useMerklRewards(1);
  const totalEarnedUsd = (merklData?.flatMap((d) => d.rewards) ?? []).reduce((sum, r) => {
    return sum + parseFloat(formatUnits(BigInt(r.amount), r.token.decimals)) * r.token.price;
  }, 0);

  // Merkl reward APR
  const { data: merklOpportunities } = useMerklOpportunities();
  const rewardOpportunity = merklOpportunities?.find((o) => o.name === "Yld Borrow crvUSD");
  const rewardApr = rewardOpportunity?.apr;

  // Fetch cvxCRV price from on-chain oracles
  const { price: cvxCrvPrice } = useCvxCrvPrice();

  // Fetch vault cache for all underlying prices and on-chain APYs
  const { data: vaultCache } = useVaultCache();

  // On-chain APY from cache (convertToAssets now vs 24h ago), fallback to Kong
  const cachedApy = vault ? (vaultCache as Record<string, { apy?: number | null }> | undefined)?.[vault.id]?.apy : null;
  const displayApy = cachedApy != null ? `${cachedApy.toFixed(2)}%` : displayApyFormatted;

  // Get the correct underlying price based on vault's asset
  const getUnderlyingPrice = (): number => {
    if (!vault) return cvxCrvPrice;
    switch (vault.assetSymbol) {
      case "cvgCVX":
        return vaultCache?.cvgCvxPrice ?? 0;
      case "pxCVX":
        return 0; // TODO: uncomment when yspxcvx is live — vaultCache?.pxCvxPrice ?? 0
      case "cvxCRV":
      default:
        return cvxCrvPrice;
    }
  };
  const underlyingPrice = getUnderlyingPrice();

  // Fetch price per share from on-chain
  const vaultAddressTyped = (vault?.address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const { pricePerShare, pricePerShareFormatted, isLoading: ppsLoading } = usePricePerShare(vaultAddressTyped);

  // Fetch user balances
  const { balance: tokenBalanceRaw, decimals: tokenDecimals, formatted: tokenBalanceFormatted, isLoading: tokenBalanceLoading, refetch: refetchTokenBalance } = useTokenBalance(TOKENS.CVXCRV);
  const {
    balance: vaultBalanceRaw,
    decimals: vaultDecimals,
    formatted: vaultBalanceFormatted,
    isLoading: vaultBalanceLoading,
    refetch: refetchVaultBalance,
  } = useVaultBalance(
    vaultAddressTyped,
    pricePerShare,
    underlyingPrice
  );

  const tokenBalance = parseFloat(tokenBalanceFormatted) || 0;
  const vaultBalance = parseFloat(vaultBalanceFormatted) || 0;
  // Raw formatted strings preserve full precision for MAX button
  const tokenBalanceMax = tokenBalanceFormatted;
  const vaultBalanceMax = vaultBalanceFormatted;
  const exchangeRate = pricePerShare;
  const [rateInverted, setRateInverted] = useState(false);

  // Zap input token balance (for MAX button)
  const isZapInputEth = zapInputToken?.address.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const { data: zapInputBalance, refetch: refetchZapInputBalance } = useBalance({
    address: userAddress,
    token: isZapInputEth ? undefined : (zapInputToken?.address as `0x${string}`),
    query: {
      enabled: !!userAddress && !!zapInputToken,
    },
  });
  const zapInputBalanceFormatted = zapInputBalance?.formatted ?? "0";
  // For ETH: reserve gas from max balance so user doesn't accidentally drain wallet
  const zapInputMaxFormatted = isZapInputEth && zapInputBalance?.value
    ? getMaxEthAmount(zapInputBalance.value, gasPrice)
    : zapInputBalanceFormatted;
  const zapInputBalanceNum = parseFloat(zapInputBalanceFormatted) || 0;

  // Vault actions (approve, deposit, withdraw)
  const {
    needsApproval,
    approve,
    deposit,
    withdraw,
    executeAfterPreview: executeVaultAfterPreview,
    reset: resetVaultActions,
    status: txStatus,
    error: txError,
    isLoading,
    isSuccess,
    isReverted,
    depositHash,
    withdrawHash,
    simulationResult: vaultSimulationResult,
  } = useVaultActions(vaultAddressTyped, vault?.assetAddress ?? TOKENS.CVXCRV, vault?.assetDecimals ?? 18);

  // Zap quote - fetch route from Enso (debounced to prevent rate limiting)
  // Pause quote fetching when simulation/price impact modals are open, or when contract explorer is open
  const { quote: zapQuote, isLoading: zapQuoteLoading, error: zapQuoteError } = useZapQuote({
    inputToken: zapDirection === "in" ? zapInputToken : null,
    outputToken: zapDirection === "out" ? zapOutputToken : null,
    inputAmount: debouncedZapAmount,
    direction: zapDirection,
    vaultAddress: vault?.address ?? "",
    underlyingToken: vault?.assetAddress ?? "",
    slippage: zapSlippage,
    underlyingTokenPrice: underlyingPrice, // For illiquid tokens like cvgCVX
    paused: showSimulationModal || showPriceImpactModal || explorerOpen || zapInProgress,
  });

  // Zap actions (approve + execute)
  const {
    needsApproval: zapNeedsApproval,
    approve: zapApprove,
    executeZap,
    reset: resetZapActions,
    status: zapStatus,
    error: zapActionError,
    isLoading: zapIsLoading,
    isSuccess: zapIsSuccess,
    isReverted: zapIsReverted,
    zapHash,
    pendingApproval: zapPendingApproval,
    approvalProgress: zapApprovalProgress,
    isApproving: zapIsApproving,
    isFlashbotsEnabled,
    isFlashbotsSupported,
    toggleFlashbots,
    simulationResult,
  } = useZapActions(zapQuote);

  // Preserve last zap approval data so content stays in DOM during close animation
  const lastZapApprovalRef = useRef(zapPendingApproval);
  if (zapPendingApproval) lastZapApprovalRef.current = zapPendingApproval;
  const showZapApprovalCard = !!(zapPendingApproval && (zapStatus === "needsApproval" || zapStatus === "approving" || zapStatus === "waitingApproval"));

  // Sync zapInProgress with zapIsLoading to pause quote fetching during transaction
  useEffect(() => {
    setZapInProgress(zapIsLoading);
  }, [zapIsLoading]);

  // Run simulation for preview mode and show modal with result
  const runSimulationPreview = useCallback(async () => {
    if (!zapQuote) return;
    setIsSimulatingPreview(true);
    try {
      // Run simulation but don't send tx - executeZap returns the result directly
      const result = await executeZap({ previewOnly: true });
      if (result) {
        simulationBlock.current = currentBlock ?? 0n;
        setShowSimulationModal(true);
        // Fetch ETH price for gas cost display
        if (publicClient) {
          publicClient.readContract({
            address: CHAINLINK_ETH_USD,
            abi: [{
              name: "latestRoundData",
              type: "function",
              stateMutability: "view",
              inputs: [],
              outputs: [
                { name: "roundId", type: "uint80" },
                { name: "answer", type: "int256" },
                { name: "startedAt", type: "uint256" },
                { name: "updatedAt", type: "uint256" },
                { name: "answeredInRound", type: "uint80" },
              ],
            }],
            functionName: "latestRoundData",
          }).then(resultData => {
            const answer = resultData[1] as bigint;
            setEthPrice(Number(answer) / 1e8);
          }).catch(() => { });
        }
      }
      return result;
    } finally {
      setIsSimulatingPreview(false);
    }
  }, [zapQuote, executeZap, publicClient, CHAINLINK_ETH_USD]);

  const inputAmount = parseFloat(amount) || 0;
  const outputAmount = activeTab === "deposit"
    ? inputAmount / exchangeRate
    : inputAmount * exchangeRate;
  // Compare with bigints to avoid float precision issues (e.g. 192.12403126 > 192.12403125836392)
  const hasInsufficientBalance = (() => {
    if (!amount || inputAmount === 0) return false;
    try {
      const decimals = activeTab === "deposit" ? tokenDecimals : vaultDecimals;
      const rawBalance = activeTab === "deposit" ? tokenBalanceRaw : vaultBalanceRaw;
      const inputBigInt = parseUnits(amount, decimals);
      return inputBigInt > rawBalance;
    } catch {
      return inputAmount > (activeTab === "deposit" ? tokenBalance : vaultBalance);
    }
  })();

  // Zap insufficient balance check (bigint precision)
  const hasZapInsufficientBalance = (() => {
    if (!zapAmount || Number(zapAmount) === 0) return false;
    try {
      if (zapDirection === "in") {
        if (!zapInputBalance) return false;
        const inputBigInt = parseUnits(zapAmount, zapInputBalance.decimals);
        return inputBigInt > zapInputBalance.value;
      } else {
        const inputBigInt = parseUnits(zapAmount, vaultDecimals);
        return inputBigInt > vaultBalanceRaw;
      }
    } catch {
      return zapDirection === "in" ? Number(zapAmount) > zapInputBalanceNum : Number(zapAmount) > vaultBalance;
    }
  })();

  // Run Tenderly simulation preview for vault deposit/withdraw
  const runVaultSimulationPreview = useCallback(async () => {
    if (!vault || !amount) return null;
    setIsSimulatingPreview(true);
    try {
      const result = activeTab === "deposit"
        ? await deposit(amount, { previewOnly: true })
        : await withdraw(amount, { previewOnly: true });
      if (result) {
        simulationBlock.current = currentBlock ?? 0n;
        setShowSimulationModal(true);
        // Fetch ETH price for gas cost display
        if (publicClient) {
          publicClient.readContract({
            address: CHAINLINK_ETH_USD,
            abi: [{
              name: "latestRoundData",
              type: "function",
              stateMutability: "view",
              inputs: [],
              outputs: [
                { name: "roundId", type: "uint80" },
                { name: "answer", type: "int256" },
                { name: "startedAt", type: "uint256" },
                { name: "updatedAt", type: "uint256" },
                { name: "answeredInRound", type: "uint80" },
              ],
            }],
            functionName: "latestRoundData",
          }).then(resultData => {
            const answer = resultData[1] as bigint;
            setEthPrice(Number(answer) / 1e8);
          }).catch(() => { });
        }
      }
      return result;
    } finally {
      setIsSimulatingPreview(false);
    }
  }, [vault, amount, activeTab, deposit, withdraw, publicClient, CHAINLINK_ETH_USD, currentBlock]);

  // Use debug simulation result as fallback for testing
  // For deposit/withdraw tabs, use vaultSimulationResult; for zap tab, use zapActions simulationResult
  const effectiveSimulationResult = (activeTab === "zap" ? simulationResult : vaultSimulationResult) || debugSimulationResult;

  // Track vault view on mount
  const hasTrackedView = useRef(false);
  useEffect(() => {
    if (vault && !hasTrackedView.current) {
      trackVaultView(id, vault.name);
      hasTrackedView.current = true;
    }
  }, [id, vault]);

  // Track transaction status changes
  const prevTxStatus = useRef(txStatus);
  useEffect(() => {
    if (prevTxStatus.current !== txStatus && vault) {
      // Track approval success
      if (prevTxStatus.current === "waitingApproval" && txStatus === "idle") {
        trackApprovalSuccess(vault.assetSymbol, id);
      }
      // Track deposit success (only when we have a tx hash confirming it happened)
      if (prevTxStatus.current === "waitingTx" && txStatus === "success" && activeTab === "deposit" && depositHash) {
        trackDepositSuccess(id, amount, vault.assetSymbol);
      }
      // Track withdraw success (only when we have a tx hash confirming it happened)
      if (prevTxStatus.current === "waitingTx" && txStatus === "success" && activeTab === "withdraw" && withdrawHash) {
        trackWithdrawSuccess(id, amount, vault.assetSymbol);
      }
      // Track errors or cancellations
      if (txStatus === "error" && prevTxStatus.current !== "error") {
        const action = prevTxStatus.current === "waitingApproval" || prevTxStatus.current === "approving"
          ? "approval"
          : activeTab === "deposit"
            ? "deposit"
            : "withdraw";

        // Check if user cancelled (rejected in wallet)
        if (txError && isUserRejection(txError)) {
          trackTransactionCancelled(action, id);
        } else {
          trackTransactionError(action, id, txError || "Transaction failed");
        }
      }
    }
    prevTxStatus.current = txStatus;
  }, [txStatus, txError, vault, id, amount, activeTab, depositHash, withdrawHash]);

  if (!vault) {
    notFound();
  }

  // Check if approval needed for deposit
  const requiresApproval = activeTab === "deposit" && amount && needsApproval(amount);

  const handleSubmit = async (exactApprovalAmount?: bigint) => {
    if (!inputAmount || hasInsufficientBalance || !vault) return;

    if (activeTab === "deposit") {
      if (requiresApproval) {
        trackApprovalInitiated(vault.assetSymbol, id);
        // Set multi-step state for approval + deposit
        const outputAmt = pricePerShare ? (inputAmount / pricePerShare).toFixed(4) : inputAmount.toFixed(4);
        setPendingTxDetails({
          fromAmount: inputAmount.toFixed(4),
          fromSymbol: vault.assetSymbol,
          fromLogo: `/tokens/${vault.assetSymbol.toLowerCase()}.png`,
          toAmount: outputAmt,
          toSymbol: vault.symbol,
          toLogo: vault.logo,
        });
        setPendingMultiStep({
          type: "deposit",
          step: 1,
          approvalToken: vault.assetSymbol,
          spenderName: vault.symbol,
        });
        approve(exactApprovalAmount);
      } else if (showSimulationPreview) {
        const result = await runVaultSimulationPreview();
        if (result) return; // Modal opened — bail
        // No simulation data (e.g. Anvil) — fall through to execute
        trackDepositInitiated(id, amount, vault.assetSymbol);
        const outputAmt = pricePerShare ? (inputAmount / pricePerShare).toFixed(4) : inputAmount.toFixed(4);
        setPendingTxDetails({
          fromAmount: inputAmount.toFixed(4),
          fromSymbol: vault.assetSymbol,
          fromLogo: `/tokens/${vault.assetSymbol.toLowerCase()}.png`,
          toAmount: outputAmt,
          toSymbol: vault.symbol,
          toLogo: vault.logo,
        });
        deposit(amount);
      } else {
        trackDepositInitiated(id, amount, vault.assetSymbol);
        // Set pending tx details for display
        const outputAmt = pricePerShare ? (inputAmount / pricePerShare).toFixed(4) : inputAmount.toFixed(4);
        setPendingTxDetails({
          fromAmount: inputAmount.toFixed(4),
          fromSymbol: vault.assetSymbol,
          fromLogo: `/tokens/${vault.assetSymbol.toLowerCase()}.png`,
          toAmount: outputAmt,
          toSymbol: vault.symbol,
          toLogo: vault.logo,
        });
        deposit(amount);
      }
    } else {
      if (showSimulationPreview) {
        const result = await runVaultSimulationPreview();
        if (result) return; // Modal opened — bail
        // No simulation data (e.g. Anvil) — fall through to execute
      }
      trackWithdrawInitiated(id, amount, vault.assetSymbol);
      // Set pending tx details for display
      const outputAmt = pricePerShare ? (inputAmount * pricePerShare).toFixed(4) : inputAmount.toFixed(4);
      setPendingTxDetails({
        fromAmount: inputAmount.toFixed(4),
        fromSymbol: vault.symbol,
        fromLogo: vault.logo,
        toAmount: outputAmt,
        toSymbol: vault.assetSymbol,
        toLogo: `/tokens/${vault.assetSymbol.toLowerCase()}.png`,
      });
      withdraw(amount);
    }
  };

  // Track transaction hashes to detect new successful transactions
  const lastHandledDepositHash = useRef<string | null>(null);
  const lastHandledWithdrawHash = useRef<string | null>(null);
  const lastHandledZapHash = useRef<string | null>(null);

  // Handle deposit/withdraw completion (success or revert) - refetch balances and reset form
  useEffect(() => {
    const currentHash = depositHash || withdrawHash;
    const isComplete = isSuccess || isReverted;
    if (isComplete && currentHash && currentHash !== lastHandledDepositHash.current && currentHash !== lastHandledWithdrawHash.current) {
      // Mark as handled
      if (depositHash) lastHandledDepositHash.current = depositHash;
      if (withdrawHash) lastHandledWithdrawHash.current = withdrawHash;
      // Refetch all balances after tx completes (even on revert, tokens are still there)
      refetchTokenBalance();
      refetchVaultBalance();
      // Show success/error message, clear form and reset state (use setTimeout to avoid sync setState in effect)
      const txResult = {
        hash: currentHash,
        status: (isSuccess ? "success" : "reverted") as "success" | "reverted",
        type: (depositHash ? "deposit" : "withdraw") as "deposit" | "withdraw" | "zap",
      };
      setTimeout(() => {
        setLastTxResult(txResult);
        setAmount("");
        setZapAmount("");

        // Show toast notification
        if (isSuccess) {
          // Show success animation in form
          setShowTxSuccess({
            show: true,
            type: depositHash ? "deposit" : "withdraw",
            hash: currentHash,
          });
          // Clear success animation after 2 seconds
          setTimeout(() => {
            setShowTxSuccess(null);
            setPendingTxDetails(null);
            setPendingMultiStep(null);
            resetVaultActions();
          }, 2000);

          toast.success(`${depositHash ? "Deposit" : "Withdrawal"} successful!`, {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${currentHash}`, "_blank"),
            },
          });
        } else if (isReverted) {
          // Show reverted animation in form
          setShowTxReverted({
            show: true,
            type: depositHash ? "deposit" : "withdraw",
            hash: currentHash,
          });
          // Clear reverted animation after 3 seconds and reset
          setTimeout(() => {
            setShowTxReverted(null);
            setPendingTxDetails(null);
            setPendingMultiStep(null);
            resetVaultActions();
          }, 3000);

          toast.error(`${depositHash ? "Deposit" : "Withdrawal"} failed - transaction reverted`, {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${currentHash}`, "_blank"),
            },
          });
        }
      }, 0);
    }
  }, [isSuccess, isReverted, depositHash, withdrawHash, refetchTokenBalance, refetchVaultBalance, resetVaultActions]);

  // Auto-execute deposit after vault approval succeeds (for multi-step transactions)
  const prevTxStatusRef = useRef<string | null>(null);
  useEffect(() => {
    // Check if we just completed approval (status transitioned from waitingApproval to idle)
    // and we're in a deposit multi-step flow
    if (
      pendingMultiStep?.type === "deposit" &&
      pendingMultiStep.step === 1 &&
      prevTxStatusRef.current === "waitingApproval" &&
      txStatus === "idle"
    ) {
      // Approval succeeded - auto-execute the deposit
      setPendingMultiStep(prev => prev ? { ...prev, step: 2 } : null);
      // Small delay to ensure allowance is refetched
      setTimeout(() => {
        if (amount) {
          deposit(amount);
        }
      }, 100);
    }
    prevTxStatusRef.current = txStatus;
  }, [txStatus, pendingMultiStep, activeTab, amount, deposit]);

  // Clear multi-step state on error or user cancellation (vault actions)
  useEffect(() => {
    if (pendingMultiStep?.type === "deposit" && (txStatus === "error" || txError)) {
      setPendingMultiStep(null);
      setPendingTxDetails(null);
    }
  }, [txStatus, txError, pendingMultiStep, activeTab]);

  // Handle zap completion (success or revert) - refetch balances and reset form
  useEffect(() => {
    const isComplete = zapIsSuccess || zapIsReverted;
    if (isComplete && zapHash && zapHash !== lastHandledZapHash.current) {
      // Mark as handled
      lastHandledZapHash.current = zapHash;
      // Refetch all balances after tx completes (even on revert, tokens are still there)
      refetchTokenBalance();
      refetchVaultBalance();
      refetchZapInputBalance();
      // Show success/error message, clear form and reset state (use setTimeout to avoid sync setState in effect)
      const txResult = {
        hash: zapHash,
        status: (zapIsSuccess ? "success" : "reverted") as "success" | "reverted",
        type: "zap" as "deposit" | "withdraw" | "zap",
      };
      setTimeout(() => {
        setLastTxResult(txResult);
        setAmount("");
        setZapAmount("");

        // Show toast notification
        if (zapIsSuccess) {
          // Show success animation in form
          setShowTxSuccess({
            show: true,
            type: "zap",
            hash: zapHash,
          });
          // Clear success animation after 2 seconds
          setTimeout(() => {
            setShowTxSuccess(null);
            setPendingTxDetails(null);
            setPendingMultiStep(null);
            resetZapActions();
          }, 2000);

          if (vault) trackZapSuccess(vault.id, zapDirection, zapDirection === "in" ? (zapInputToken?.symbol ?? "") : vault.symbol, zapDirection === "in" ? vault.symbol : (zapOutputToken?.symbol ?? ""), zapAmount || "0", zapQuote?.outputAmountFormatted ?? "0");
          toast.success("Zap successful!", {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${zapHash}`, "_blank"),
            },
          });
        } else if (zapIsReverted) {
          // Show reverted animation in form
          setShowTxReverted({
            show: true,
            type: "zap",
            hash: zapHash,
          });
          // Clear reverted animation after 3 seconds and reset
          setTimeout(() => {
            setShowTxReverted(null);
            setPendingTxDetails(null);
            setPendingMultiStep(null);
            resetZapActions();
          }, 3000);

          toast.error("Zap failed - transaction reverted", {
            action: {
              label: "View Tx",
              onClick: () => window.open(`https://etherscan.io/tx/${zapHash}`, "_blank"),
            },
          });
        }
      }, 0);
    }
  }, [zapIsSuccess, zapIsReverted, zapHash, refetchTokenBalance, refetchVaultBalance, refetchZapInputBalance, resetZapActions, setZapAmount]);

  // Reset stale zap approval state when user changes inputs
  useEffect(() => {
    if (zapStatus === "needsApproval") {
      resetZapActions();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zapAmount, zapDirection, zapInputToken?.address, zapOutputToken?.address]);

  // Show toast notifications for errors
  useEffect(() => {
    if (txError) {
      console.log("[TOAST ERROR] txError:", txError);
      toast.error(txError);
    }
  }, [txError]);

  useEffect(() => {
    if (zapActionError) {
      console.log("[TOAST ERROR] zapActionError:", zapActionError);
      toast.error(zapActionError);
    }
  }, [zapActionError]);

  // Show toast for quote errors (with friendly message and deduplication)
  const lastQuoteErrorRef = useRef<string | null>(null);

  // Clear error ref when inputs change (so new inputs can show the same error again)
  useEffect(() => {
    lastQuoteErrorRef.current = null;
  }, [zapInputToken?.address, zapOutputToken?.address, debouncedZapAmount, zapDirection]);

  useEffect(() => {
    if (zapQuoteError) {
      const friendlyMessage = parseQuoteError(zapQuoteError);
      console.log("[TOAST ERROR] zapQuoteError:", zapQuoteError, "friendly:", friendlyMessage);
      // Only show toast if it's a different error message
      if (lastQuoteErrorRef.current !== friendlyMessage) {
        lastQuoteErrorRef.current = friendlyMessage;
        toast.error(friendlyMessage);
      }
    }
    // Don't clear ref on success - prevents duplicate toasts when same error recurs during retries
  }, [zapQuoteError]);

  return (
    <div className="min-h-screen bg-[var(--background)] overflow-x-hidden">
      <Header />

      <main style={{ paddingTop: "calc(4rem + var(--test-banner-height))", overflowX: "clip" }}>
        {/* Breadcrumb navigation */}
        <div className="border-b border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
            <nav className="flex items-center gap-2 text-sm">
              <Link
                href="/"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                yld Vaults
              </Link>
              <ChevronRight size={14} className="text-[var(--muted-foreground)]" />
              <span className="text-[var(--foreground)]">{vault.symbol}</span>
            </nav>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <div className="grid lg:grid-cols-5 gap-8 lg:gap-12">
            {/* Left column - Info */}
            <div className="lg:col-span-3 space-y-8 min-w-0 overflow-hidden">
              {/* Section Header */}
              <div>
                <p className="mono text-sm text-[var(--muted-foreground)] mb-2">
                  [003] Vault
                </p>
                <div className="flex items-center gap-3 mb-4">
                  {vault.logo && (
                    <Image
                      src={vault.logo}
                      alt={vault.name}
                      width={40}
                      height={40}
                      className="rounded-full translate-y-[1px]"
                    />
                  )}
                  <div className="relative" ref={vaultSelectorRef}>
                    <button
                      onClick={() => setVaultSelectorOpen(!vaultSelectorOpen)}
                      className="flex items-center gap-2 text-2xl md:text-3xl font-medium tracking-tight leading-none hover:text-[var(--accent)] transition-colors"
                    >
                      {vault.name}
                      <ChevronDown
                        size={24}
                        className={cn(
                          "transition-transform text-[var(--muted-foreground)]",
                          vaultSelectorOpen && "rotate-180"
                        )}
                      />
                    </button>
                    {vaultSelectorOpen && (
                      <div className="absolute top-full left-0 mt-2 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg z-50 min-w-[200px] py-1 max-h-[300px] overflow-y-auto">
                        {availableVaults.map((v) => {
                          const isSelected = v.id === normalizedId;
                          return (
                            <button
                              key={v.id}
                              onClick={() => {
                                setVaultSelectorOpen(false);
                                if (!isSelected) {
                                  router.push(`/vaults/${v.id}`);
                                }
                              }}
                              className={cn(
                                "w-full px-4 py-2.5 text-left flex items-center gap-3 hover:bg-[var(--muted)] transition-colors",
                                isSelected && "bg-[var(--muted)] border-l-2 border-l-[var(--accent)]"
                              )}
                            >
                              {v.logo && (
                                <Image
                                  src={v.logo}
                                  alt={v.name}
                                  width={24}
                                  height={24}
                                  className="rounded-full"
                                />
                              )}
                              <span className={cn(
                                "font-medium flex-1",
                                isSelected && "text-[var(--accent)]"
                              )}>
                                {v.name}
                              </span>
                              {isSelected && (
                                <Check size={16} className="text-[var(--accent)]" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-[var(--muted-foreground)] max-w-xl leading-relaxed">
                  {vault.longDescription}
                </p>
              </div>

              {/* Lending Position / Borrow CTA */}
              {vault.type === "vault" && controllerAddress && (() => {
                if (lendingPosition?.hasLoan && (onChainRates || curveVault)) {
                  const collateralApy = cachedApy ?? yearnVault?.apy ?? 0;
                  const borrowApy = onChainRates?.borrowApy ?? (curveVault ? (Math.exp(curveVault.rates.borrowApr) - 1) * 100 : 0);
                  const display = buildLendingPositionDisplay(
                    lendingPosition.collateral,
                    lendingPosition.debt,
                    underlyingPrice * pricePerShare,
                    collateralApy,
                    borrowApy,
                    18,
                    lendingPosition.stablecoin,
                  );
                  return (
                    <Link
                      href={`/vaults/${vault.id}/lending`}
                      className="lending-card block group"
                    >
                      <div className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-3">
                          <Image src="/curve-logo.png" alt="Curve" width={14} height={14} className="rounded-full" />
                          <span className="text-sm font-medium">Lending Position</span>
                          <span className="text-xs text-[var(--muted-foreground)]">Curve LlamaLend</span>
                          <ArrowUpRight size={14} className="ml-auto text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] transition-colors" />
                        </div>
                        <div className="grid grid-cols-4 gap-3">
                          <div>
                            <p className="text-xs text-[var(--muted-foreground)] mb-0.5">Collateral</p>
                            <div className="flex items-center gap-1">
                              {vault.logo && <Image src={vault.logo} alt={vault.symbol} width={12} height={12} className="rounded-full" />}
                              <span className="mono text-sm font-medium">{display.collateralFormatted}</span>
                            </div>
                            <p className="text-xs text-green-500 mono">{display.collateralApyFormatted} APY</p>
                          </div>
                          <div>
                            <p className="text-xs text-[var(--muted-foreground)] mb-0.5">Debt</p>
                            <div className="flex items-center gap-1">
                              <Image src="/tokens/crvusd.png" alt="crvUSD" width={12} height={12} className="rounded-full" />
                              <span className="mono text-sm font-medium">{display.debtFormatted}</span>
                            </div>
                            <p className="text-xs text-red-500 mono">{display.borrowApyFormatted} APY</p>
                          </div>
                          <div>
                            <p className="text-xs text-[var(--muted-foreground)] mb-0.5">Leverage</p>
                            <p className="mono text-sm font-medium">{display.leverageFormatted}</p>
                            <p className={cn("text-xs mono", display.netApy >= 0 ? "text-green-500" : "text-red-500")}>
                              {display.netApyFormatted} NET
                              {vault.id === "ycvxcrv" && rewardApr != null && (
                                <span className="inline-flex items-center gap-0.5 text-green-400 ml-1">
                                  <Gift size={9} />+{rewardApr.toFixed(1)}%
                                </span>
                              )}
                            </p>
                          </div>
                          <div>
                            {(() => {
                              const h = formatHealth(lendingPosition.health); return (<>
                                <p className="text-xs text-[var(--muted-foreground)] mb-0.5">Health</p>
                                <p className={`mono text-sm font-medium ${h.color}`}>{h.value.toFixed(0)}%</p>
                              </>);
                            })()}
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                }
                return (
                  <Link
                    href={`/vaults/${vault.id}/lending`}
                    className="collateral-link block w-full"
                    style={{ display: "flex" }}
                  >
                    <span className="w-full flex items-center gap-2 !justify-start !px-4" style={{ height: 44 }}>
                      <Image src="/curve-logo.png" alt="Curve" width={16} height={16} className="rounded-full flex-shrink-0" />
                      <span className="text-sm font-medium whitespace-nowrap">Borrow against {vault.symbol}</span>
                      <span className="text-xs font-normal text-[var(--muted-foreground)] hidden sm:inline">
                        Borrow crvUSD on Curve LlamaLend
                      </span>
                      <ArrowUpRight size={14} className="ml-auto flex-shrink-0" />
                    </span>
                  </Link>
                );
              })()}

              {/* Rewards Banner */}
              {vault.id === "ycvxcrv" && (
                <Link
                  href="/rewards"
                  className="block border border-green-400/20 bg-green-400/5 rounded-md px-4 group hover:border-green-400/40 transition-colors"
                  style={{ height: 46 }}
                >
                  <div className="flex items-center gap-2 h-full">
                    <Image src="/tokens/crvusd.png" alt="crvUSD" width={16} height={16} className="rounded-full" />
                    {rewardApr != null && <span className="text-sm font-bold text-green-400 mono">{rewardApr.toFixed(1)}% APR</span>}
                    {rewardApr != null && <span className="text-green-400/40">·</span>}
                    <span className="text-sm font-medium text-green-400">crvUSD Rewards</span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {totalEarnedUsd > 0 ? `Earning ${formatUsd(totalEarnedUsd)}` : `Earn crvUSD by borrowing against ${vault.symbol}`}
                    </span>
                    <ArrowUpRight size={14} className="ml-auto text-green-400/60 group-hover:text-green-400 transition-colors" />
                  </div>
                </Link>
              )}

              {/* Stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-xl p-4 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                  <div className="flex items-center gap-2 mb-3 text-[var(--muted-foreground)]">
                    <TrendingUp size={16} />
                    <span className="text-xs font-medium uppercase tracking-wider">APY</span>
                  </div>
                  <p className="mono xl:text-2xl text-xl font-medium text-[var(--success)]">
                    {yearnLoading ? "..." : displayApy}
                  </p>
                </div>

                <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-xl p-4 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                  <div className="flex items-center gap-2 mb-3 text-[var(--muted-foreground)]">
                    <Wallet size={16} />
                    <span className="text-xs font-medium uppercase tracking-wider">TVL</span>
                  </div>
                  <p className="mono xl:text-2xl text-xl font-medium">
                    {yearnLoading ? "..." : yearnVault?.tvlFormatted ?? "—"}
                  </p>
                </div>

                <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-xl p-4 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                  <div className="flex items-center gap-2 mb-3 text-[var(--muted-foreground)]">
                    <Banknote size={16} />
                    <span className="text-xs font-medium uppercase tracking-wider">Price/Share</span>
                  </div>
                  <p className="mono xl:text-2xl text-xl font-medium">
                    {ppsLoading ? "..." : pricePerShareFormatted}
                  </p>
                </div>

                <div className="bg-[var(--background)]/80 backdrop-blur-sm border border-[var(--border)] rounded-xl p-4 flex flex-col justify-between group hover:border-[var(--muted-foreground)]/30 transition-colors">
                  <div className="flex items-center gap-2 mb-3 text-[var(--muted-foreground)]">
                    <Coins size={16} />
                    <span className="text-xs font-medium uppercase tracking-wider">Token</span>
                  </div>
                  <p className="mono xl:text-2xl text-xl font-medium">
                    {vault.assetSymbol}
                  </p>
                </div>
              </div>

              {/* Details */}
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] bg-[var(--muted)]/20">
                  <Info size={14} className="text-[var(--muted-foreground)]" />
                  <h3 className="text-sm font-medium text-[var(--foreground)]">{vault.type === "vault" ? "Vault" : "Strategy"} Details</h3>
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {vault.type === "vault" && (
                      <tr className="border-b border-[var(--border)]/50">
                        <td className="px-3 sm:px-4 py-2.5 text-[var(--muted-foreground)] font-medium whitespace-nowrap">Vault</td>
                        <td className="px-3 sm:px-4 py-2.5 text-right mono font-medium">{vault.name}</td>
                      </tr>
                    )}
                    <tr className="border-b border-[var(--border)]/50">
                      <td className="px-3 sm:px-4 py-2.5 text-[var(--muted-foreground)] font-medium whitespace-nowrap">
                        {vault.type === "vault" ? (<><span className="hidden sm:inline">Underlying Strategy</span><span className="sm:hidden">Strategy</span></>) : "Strategy"}
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 text-right mono font-medium">{vault.strategy}</td>
                    </tr>
                    <tr className="border-b border-[var(--border)]/50">
                      <td className="px-3 sm:px-4 py-2.5 text-[var(--muted-foreground)] font-medium whitespace-nowrap">
                        <span className="hidden sm:inline">Performance Fee</span><span className="sm:hidden">Fee</span>
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 text-right mono font-medium">
                        {vault.type === "vault" ? "15% Vault + 5% Strategy" : `${vault.fees.performance}%`}
                      </td>
                    </tr>
                    <tr className={vault.underlyingStrategy && vault.type === "vault" ? "border-b border-[var(--border)]/50" : ""}>
                      <td className="px-3 sm:px-4 py-2.5 text-[var(--muted-foreground)] font-medium whitespace-nowrap">
                        <span className="hidden sm:inline">{vault.type === "strategy" ? "Strategy Contract" : "Vault Contract"}</span>
                        <span className="sm:hidden">{vault.type === "strategy" ? "Contract" : "Vault"}</span>
                      </td>
                      <td className="px-3 sm:px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5 sm:gap-2 flex-wrap">
                          <a href={vault.links?.etherscan || `https://etherscan.io/address/${vault.address}`} target="_blank" rel="noopener noreferrer" className="mono text-xs flex items-center gap-1 hover:text-[var(--accent)] transition-colors">
                            {vault.address.slice(0, 6)}...{vault.address.slice(-4)}<ExternalLink size={10} className="opacity-50" />
                          </a>
                          <button onClick={() => { navigator.clipboard.writeText(vault.address); toast.success("Address copied", { id: "copy-address" }); }} className="hover:text-[var(--accent)] text-[var(--muted-foreground)] transition-colors" aria-label="Copy vault address"><Copy size={11} /></button>
                          <button onClick={() => openExplorer(vault.address, vault.name, vault.logo, vault.type === "strategy")} className="text-[10px] px-1.5 py-0.5 bg-[var(--muted)] hover:bg-[var(--accent)] hover:text-white rounded flex items-center gap-1 transition-colors"><Search size={9} /><span className="hidden sm:inline">Explore</span></button>
                        </div>
                      </td>
                    </tr>
                    {vault.underlyingStrategy && vault.type === "vault" && (
                      <tr>
                        <td className="px-3 sm:px-4 py-2.5 text-[var(--muted-foreground)] font-medium whitespace-nowrap">
                          <span className="hidden sm:inline">Strategy Contract</span><span className="sm:hidden">Strategy</span>
                        </td>
                        <td className="px-3 sm:px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1.5 sm:gap-2 flex-wrap">
                            <a href={`https://etherscan.io/address/${vault.underlyingStrategy}`} target="_blank" rel="noopener noreferrer" className="mono text-xs flex items-center gap-1 hover:text-[var(--accent)] transition-colors">
                              {vault.underlyingStrategy.slice(0, 6)}...{vault.underlyingStrategy.slice(-4)}<ExternalLink size={10} className="opacity-50" />
                            </a>
                            <button onClick={() => { navigator.clipboard.writeText(vault.underlyingStrategy!); toast.success("Address copied", { id: "copy-address" }); }} className="hover:text-[var(--accent)] text-[var(--muted-foreground)] transition-colors" aria-label="Copy strategy address"><Copy size={11} /></button>
                            <button onClick={() => { const sc = getVaultByAddress(vault.underlyingStrategy!); openExplorer(vault.underlyingStrategy!, sc?.name || `${vault.name} Strategy`, sc?.logo, true); }} className="text-[10px] px-1.5 py-0.5 bg-[var(--muted)] hover:bg-[var(--accent)] hover:text-white rounded flex items-center gap-1 transition-colors"><Search size={9} /><span className="hidden sm:inline">Explore</span></button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* LlamaLend Market Stats */}
              {curveData && (
                <div className="p-5 rounded-xl bg-gradient-to-br from-[#121212] to-transparent border border-[#222] shadow-sm relative overflow-hidden">
                  <div className="relative z-10 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Image src="/curve-logo.png" alt="Curve" width={24} height={24} className="rounded-full" />
                        <h3 className="text-base font-medium text-[var(--foreground)]">ycvxCRV LlamaLend Market</h3>
                      </div>
                      <a
                        href={curveData.depositUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium flex items-center gap-1 text-[var(--foreground)] hover:text-[var(--accent)] transition-colors group"
                      >
                        <span>View Market</span>
                        <ExternalLink size={12} className="opacity-50 group-hover:opacity-100" />
                      </a>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
                      <div className="bg-[var(--background)]/40 backdrop-blur-sm border border-[var(--border)]/50 rounded-lg p-3 group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] mb-1">Borrow APY</p>
                        <p className="mono font-medium text-lg text-[#F24E4E]">{curveData.borrowApyFormatted}</p>
                      </div>
                      <div className="bg-[var(--background)]/40 backdrop-blur-sm border border-[var(--border)]/50 rounded-lg p-3 group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] mb-1">Total Borrowed</p>
                        <p className="mono font-medium text-lg">{curveData.totalBorrowedFormatted}</p>
                      </div>
                      <div className="bg-[var(--background)]/40 backdrop-blur-sm border border-[var(--border)]/50 rounded-lg p-3 group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] mb-1">Available to Borrow</p>
                        <p className="mono font-medium text-lg text-[var(--success)]">{curveData.availableToBorrowFormatted}</p>
                      </div>
                      <div className="bg-[var(--background)]/40 backdrop-blur-sm border border-[var(--border)]/50 rounded-lg p-3 group hover:border-[var(--muted-foreground)]/30 transition-colors">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] mb-1">Total Collateral</p>
                        <p className="mono font-medium text-lg">{curveData.collateralInAmm.toFixed(2)} ycvxCRV</p>
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">${(curveData.collateralInAmm * pricePerShare * underlyingPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right column - Action Card */}
            <div className="lg:col-span-2 min-w-0">
              <div className="sticky border border-[var(--border)] rounded-xl overflow-x-hidden w-full" style={{ top: "calc(6rem + var(--test-banner-height))" }}>
                {/* Your Wallet - visible when connected with balance, hidden during pending/success/reverted states */}
                {isConnected && vaultBalance > 0 && debugTxState === "none" && !pendingMultiStep && txStatus !== "waitingTx" && zapStatus !== "waitingTx" && !showTxSuccess?.show && !showTxReverted?.show && (
                  <div className="bg-[var(--muted)]/30 p-5 border-b border-[var(--border)]">
                    <div className="flex flex-wrap items-center justify-center gap-4">
                      <div className="text-center basis-full sm:basis-auto">
                        <span className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">Your Wallet</span>
                        <div className="mt-1">
                          {(() => {
                            const formatted = vaultBalanceLoading ? "..." : vaultBalance.toFixed(4);
                            const len = formatted.length;
                            // Scale font based on length
                            const sizeClass = len > 16 ? "text-xs" : len > 13 ? "text-sm" : len > 10 ? "text-base" : len > 8 ? "text-lg" : "text-xl";
                            const symbolSize = len > 10 ? "text-xs" : "text-sm";
                            return (
                              <>
                                <span className={`mono font-semibold ${sizeClass}`}>{formatted}</span>
                                <span className={`${symbolSize} text-[var(--muted-foreground)] ml-1`}>{vault.symbol}</span>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                      {/* Borrow button - only for vault type with LlamaLend market */}
                      {vault.type === "vault" && CURVE_CONTROLLERS[vault.address as keyof typeof CURVE_CONTROLLERS] && (
                        <button
                          onClick={handleCollateralClick}
                          className="collateral-link shrink-0"
                        >
                          <span className="whitespace-nowrap">
                            <Image src="/curve-logo.png" alt="Curve" width={14} height={14} className="inline-block rounded-full" />
                            Borrow
                            <ArrowUpRight size={12} />
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Tabs - hidden during waitingTx (vault or zap)/pendingMultiStep/success/reverted states (visible during wallet signing & simulation) */}
                {isVaultDeployed && debugTxState === "none" && !pendingMultiStep && txStatus !== "waitingTx" && zapStatus !== "waitingTx" && !showTxSuccess?.show && !showTxReverted?.show && (
                  <div className="p-5 pb-0">
                    <div className="flex border-b border-[var(--border)]">
                      {(["deposit", "withdraw", "zap"] as const).map((tab) => {
                        const isDisabled = false;
                        return (
                          <button
                            key={tab}
                            disabled={isDisabled}
                            onClick={() => {
                              if (isDisabled) return;
                              setActiveTab(tab);
                              setAmount("");
                              setZapAmount("");
                              setLastTxResult(null);
                              // Clear any pending error states when switching tabs
                              resetVaultActions();
                              resetZapActions();
                            }}
                            className={cn(
                              "flex-1 pb-3 text-sm font-medium transition-all capitalize relative",
                              isDisabled
                                ? "text-[var(--muted-foreground)]/50 cursor-not-allowed"
                                : "cursor-pointer",
                              !isDisabled && activeTab === tab
                                ? "text-[var(--foreground)]"
                                : !isDisabled && "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            )}
                            title={isDisabled ? "Vault not yet deployed" : undefined}
                          >
                            {tab}
                            {!isDisabled && activeTab === tab && (
                              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--foreground)]" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Form - min-height prevents layout shift when switching tabs */}
                <div className="p-5 space-y-5 min-h-[622px]">
                  {/* Coming Soon banner for non-deployed vaults */}
                  {!isVaultDeployed && (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                        <svg className="w-8 h-8 text-[var(--muted-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <h3 className="text-lg font-medium mb-2">Coming Soon</h3>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs">
                        This vault is not yet deployed. Check back later or follow us for updates.
                      </p>
                    </div>
                  )}

                  {/* Multi-Step Transaction Pending State - Approval + Deposit */}
                  {isVaultDeployed && pendingMultiStep?.type === "deposit" && (txStatus === "approving" || txStatus === "waitingApproval" || (txStatus === "idle" && pendingMultiStep.step === 1)) && (
                    <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300">
                      <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                        <LoadingDots />
                      </div>
                      <h3 className="text-lg font-medium mb-4">Transaction in Progress</h3>
                      {/* Multi-Step List */}
                      <div className="flex flex-col gap-3 mb-4 w-full max-w-xs">
                        {/* Step 1: Approval */}
                        <div className={cn(
                          "flex items-center gap-3 px-4 py-3 rounded-lg transition-colors",
                          pendingMultiStep.step === 1
                            ? "bg-[var(--accent)]/10 border border-[var(--accent)]/30"
                            : "bg-[var(--muted)]"
                        )}>
                          <div className={cn(
                            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                            pendingMultiStep.step === 1
                              ? "bg-[var(--accent)] text-[var(--background)]"
                              : "bg-green-500 text-white"
                          )}>
                            {pendingMultiStep.step === 1 ? (
                              <LoadingDots />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                          </div>
                          <span className={cn(
                            "text-sm",
                            pendingMultiStep.step === 1 ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]"
                          )}>
                            Approve {pendingMultiStep.approvalToken} for {pendingMultiStep.spenderName}
                          </span>
                        </div>
                        {/* Step 2: Deposit */}
                        <div className={cn(
                          "flex items-center gap-3 px-4 py-3 rounded-lg",
                          "bg-[var(--muted)] opacity-60"
                        )}>
                          <div className="w-6 h-6 flex-shrink-0 rounded-full bg-[var(--border)] flex items-center justify-center text-[var(--muted-foreground)]">
                            <Clock className="w-3.5 h-3.5" />
                          </div>
                          {pendingTxDetails && (
                            <div className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)]">
                              <span>Deposit</span>
                              <img src={pendingTxDetails.fromLogo} alt={pendingTxDetails.fromSymbol} className="w-4 h-4 rounded-full" />
                              <span className="mono">{pendingTxDetails.fromAmount} {pendingTxDetails.fromSymbol}</span>
                              <span>→</span>
                              <img src={pendingTxDetails.toLogo} alt={pendingTxDetails.toSymbol} className="w-4 h-4 rounded-full" />
                              <span className="mono">{pendingTxDetails.toAmount} {pendingTxDetails.toSymbol}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs">
                        Confirm the approval in your wallet. The deposit will start automatically once approved.
                      </p>
                    </div>
                  )}

                  {/* Transaction Pending State - Deposit/Withdraw */}
                  {isVaultDeployed && (((isDebugDeposit || isDebugWithdraw) && isDebugPending) || (txStatus === "waitingTx" && (depositHash || withdrawHash))) && (
                    <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300">
                      <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                        <LoadingDots />
                      </div>
                      <h3 className="text-lg font-medium mb-2">Awaiting Confirmation</h3>
                      {/* Multi-Step List (when in multi-step mode) */}
                      {pendingMultiStep?.type === "deposit" && pendingMultiStep.step === 2 && pendingTxDetails && (
                        <div className="flex flex-col gap-3 mb-4 w-full max-w-xs">
                          {/* Step 1: Approval (completed) */}
                          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--muted)]">
                            <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                              <Check className="w-4 h-4 text-white" />
                            </div>
                            <span className="text-sm text-[var(--muted-foreground)]">
                              Approve {pendingMultiStep.approvalToken} for {pendingMultiStep.spenderName}
                            </span>
                          </div>
                          {/* Step 2: Deposit (active) */}
                          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30">
                            <div className="w-6 h-6 flex-shrink-0 rounded-full bg-[var(--accent)] flex items-center justify-center text-[var(--background)]">
                              <LoadingDots />
                            </div>
                            <div className="flex items-center gap-1.5 text-sm">
                              <span>Deposit</span>
                              <img src={pendingTxDetails.fromLogo} alt={pendingTxDetails.fromSymbol} className="w-4 h-4 rounded-full" />
                              <span className="mono">{pendingTxDetails.fromAmount} {pendingTxDetails.fromSymbol}</span>
                              <span>→</span>
                              <img src={pendingTxDetails.toLogo} alt={pendingTxDetails.toSymbol} className="w-4 h-4 rounded-full" />
                              <span className="mono">{pendingTxDetails.toAmount} {pendingTxDetails.toSymbol}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Single Transaction Details (when not in multi-step mode) */}
                      {!pendingMultiStep && (() => {
                        const details = (isDebugDeposit || isDebugWithdraw) ? debugTxDetails : pendingTxDetails;
                        return details && (
                          <div className="flex items-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg">
                            <img src={details.fromLogo} alt={details.fromSymbol} className="w-5 h-5 rounded-full" />
                            <span className="mono text-sm">{details.fromAmount} {details.fromSymbol}</span>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--muted-foreground)]">
                              <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                            <img src={details.toLogo} alt={details.toSymbol} className="w-5 h-5 rounded-full" />
                            <span className="mono text-sm">{details.toAmount} {details.toSymbol}</span>
                          </div>
                        );
                      })()}
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                        Your {isDebugDeposit ? "deposit" : isDebugWithdraw ? "withdraw" : activeTab} transaction is being confirmed on-chain.
                      </p>
                      <a
                        href={`https://etherscan.io/tx/${depositHash || withdrawHash || debugHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}

                  {/* Transaction Success State - Deposit/Withdraw */}
                  {isVaultDeployed && (((isDebugDeposit || isDebugWithdraw) && isDebugSuccess) || (showTxSuccess?.show && (showTxSuccess.type === "deposit" || showTxSuccess.type === "withdraw"))) && (
                    <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
                      <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                        <Check className="w-8 h-8 text-green-500" />
                      </div>
                      <h3 className="text-lg font-medium mb-2 text-green-500">
                        {isDebugDeposit ? "Deposit" : isDebugWithdraw ? "Withdrawal" : (showTxSuccess?.type === "deposit" ? "Deposit" : "Withdrawal")} Successful
                      </h3>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                        Your transaction has been confirmed.
                      </p>
                      <a
                        href={`https://etherscan.io/tx/${showTxSuccess?.hash || debugHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}

                  {/* Transaction Reverted State - Deposit/Withdraw */}
                  {isVaultDeployed && (((isDebugDeposit || isDebugWithdraw) && isDebugReverted) || (showTxReverted?.show && (showTxReverted.type === "deposit" || showTxReverted.type === "withdraw"))) && (
                    <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
                      <div className="w-16 h-16 rounded-full bg-[var(--destructive)]/20 flex items-center justify-center mb-4">
                        <X className="w-8 h-8 text-[var(--destructive)]" />
                      </div>
                      <h3 className="text-lg font-medium mb-2 text-[var(--destructive)]">
                        {isDebugDeposit ? "Deposit" : isDebugWithdraw ? "Withdrawal" : (showTxReverted?.type === "deposit" ? "Deposit" : "Withdrawal")} Failed
                      </h3>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                        Transaction reverted on-chain.
                      </p>
                      <a
                        href={`https://etherscan.io/tx/${showTxReverted?.hash || debugHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}

                  {/* Deposit/Withdraw Form - hidden during pending/success/reverted states and multi-step approval */}
                  {isVaultDeployed && activeTab !== "zap" && !isDebugDeposit && !isDebugWithdraw && !isDebugZap && txStatus !== "waitingTx" && !pendingMultiStep?.type && !(showTxSuccess?.show && (showTxSuccess.type === "deposit" || showTxSuccess.type === "withdraw")) && !(showTxReverted?.show && (showTxReverted.type === "deposit" || showTxReverted.type === "withdraw")) && (
                    <>
                      {/* Input */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-[var(--muted-foreground)]">Amount</span>
                          <span className="text-xs mono text-[var(--muted-foreground)]">
                            {(activeTab === "deposit" ? tokenBalanceLoading : vaultBalanceLoading)
                              ? "..."
                              : (activeTab === "deposit" ? tokenBalance : vaultBalance).toFixed(4)
                            }
                          </span>
                        </div>
                        <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="0.00"
                            className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                          />
                          <span className="mono text-sm font-medium shrink-0">
                            {activeTab === "deposit" ? vault.assetSymbol : vault.symbol}
                          </span>
                          <MaxButton
                            balance={activeTab === "deposit" ? tokenBalanceMax : vaultBalanceMax}
                            onSelect={setAmount}
                          />
                        </div>
                      </div>

                      {/* Arrow indicator */}
                      <div className="flex justify-center">
                        <div className="w-8 h-8 rounded-full bg-[var(--muted)] flex items-center justify-center">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                            <path d="M12 5v14M19 12l-7 7-7-7" />
                          </svg>
                        </div>
                      </div>

                      {/* Output */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-[var(--muted-foreground)]">You receive</span>
                        </div>
                        <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2">
                          <span className="mono text-base text-[var(--foreground)] flex-1">
                            {outputAmount > 0 ? outputAmount.toFixed(4) : "0.00"}
                          </span>
                          <span className="mono text-sm font-medium shrink-0">
                            {activeTab === "deposit" ? vault.symbol : vault.assetSymbol}
                          </span>
                        </div>
                      </div>

                      {/* Details */}
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Exchange rate</span>
                          <button
                            type="button"
                            onClick={() => setRateInverted(v => !v)}
                            className="flex items-center gap-1 mono hover:text-[var(--accent)] transition-colors"
                          >
                            {rateInverted
                              ? <>1 {vault.symbol} = {exchangeRate.toFixed(4)} {vault.assetSymbol}</>
                              : <>1 {vault.assetSymbol} = {(1 / exchangeRate).toFixed(4)} {vault.symbol}</>
                            }
                            <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                          </button>
                        </div>
                        <div className={cn(
                          "flex items-center justify-between py-1",
                          inputAmount > 0 ? "" : "invisible"
                        )}>
                          <span className="text-[var(--muted-foreground)]">Value</span>
                          {/* For deposit: input is underlying, for withdraw: output is underlying */}
                          <span className="mono">~${((activeTab === "deposit" ? inputAmount : outputAmount) * underlyingPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      </div>

                      {/* Simulation Modal for vault deposit/withdraw */}
                      {showSimulationModal && vaultSimulationResult && (
                        <SimulationModal
                          isOpen={showSimulationModal}
                          onClose={() => setShowSimulationModal(false)}
                          onConfirm={() => {
                            setShowSimulationModal(false);
                            const action = activeTab === "deposit" ? "deposit" : "withdraw";
                            if (action === "deposit") trackDepositInitiated(id, amount, vault.assetSymbol);
                            else trackWithdrawInitiated(id, amount, vault.assetSymbol);
                            executeVaultAfterPreview();
                          }}
                          simulationResult={vaultSimulationResult}
                          gasPrice={gasPrice}
                          ethPrice={ethPrice}
                          confirmText={`Confirm ${activeTab === "deposit" ? "Deposit" : "Withdraw"}`}
                        />
                      )}

                      {/* Action button */}
                      {isConnected ? (
                        requiresApproval && !isLoading && !isSimulatingPreview ? (
                          /* Approval choice: Exact or Unlimited */
                          <div className="space-y-2">
                            <div className="text-sm text-[var(--muted-foreground)]">
                              Approve {vault.assetSymbol} for{" "}<span className="whitespace-nowrap">{vault.symbol} vault <a href={`https://etherscan.io/address/${vault.address}`} target="_blank" rel="noopener noreferrer" className="inline hover:text-[var(--foreground)] transition-colors"><ExternalLink size={12} className="!inline -mt-0.5" /></a></span>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  const exactAmount = parseUnits(amount, vault.assetDecimals ?? 18);
                                  handleSubmit(exactAmount);
                                }}
                                disabled={!inputAmount || hasInsufficientBalance}
                                className={cn(
                                  "flex-1 py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                                  !inputAmount || hasInsufficientBalance
                                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                                    : "border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)]/10 cursor-pointer"
                                )}
                              >
                                {inputAmount ? inputAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"} {vault.assetSymbol}
                              </button>
                              <button
                                onClick={() => handleSubmit()}
                                disabled={!inputAmount || hasInsufficientBalance}
                                className={cn(
                                  "flex-1 py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm",
                                  !inputAmount || hasInsufficientBalance
                                    ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                                    : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer"
                                )}
                              >
                                Unlimited
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              if (showSimulationPreview && vaultSimulationResult && !showSimulationModal && currentBlock === simulationBlock.current) {
                                // Re-open cached simulation modal if same block
                                setShowSimulationModal(true);
                              } else {
                                handleSubmit();
                              }
                            }}
                            disabled={!inputAmount || hasInsufficientBalance || isLoading || isSimulatingPreview || showSimulationModal}
                            className={cn(
                              "w-full py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-base",
                              !inputAmount || hasInsufficientBalance || isLoading || isSimulatingPreview || showSimulationModal
                                ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                                : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer"
                            )}
                          >
                            {isSimulatingPreview || showSimulationModal ? (
                              <>Simulating<LoadingDots /></>
                            ) : isLoading ? (
                              <>
                                {txStatus === "approving" || txStatus === "waitingApproval"
                                  ? <>Approving<LoadingDots /></>
                                  : <>Confirm in wallet<LoadingDots /></>}
                              </>
                            ) : !inputAmount ? (
                              "Enter amount"
                            ) : hasInsufficientBalance ? (
                              "Insufficient balance"
                            ) : (
                              activeTab === "deposit" ? "Deposit" : "Withdraw"
                            )}
                          </button>
                        )
                      ) : (
                        <button
                          onClick={openConnectModal}
                          className="w-full py-4 bg-[var(--foreground)] text-[var(--background)] rounded-lg font-medium hover:opacity-90 transition-all cursor-pointer"
                        >
                          Connect Wallet
                        </button>
                      )}

                      {/* Settings icon for deposit/withdraw (opens slippage modal with simulation toggle) */}
                      <div className="flex items-center justify-end">
                        <button
                          onClick={() => setShowSlippageModal(true)}
                          className="flex items-center gap-1.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                          title="Settings"
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <line x1="4" y1="6" x2="20" y2="6" />
                            <circle cx="8" cy="6" r="2" />
                            <line x1="4" y1="18" x2="20" y2="18" />
                            <circle cx="16" cy="18" r="2" />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}

                  {/* Transaction Pending State - Zap */}
                  {isVaultDeployed && ((isDebugZap && isDebugPending) || (zapStatus === "waitingTx" && zapHash)) && (
                    <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300">
                      <div className="w-16 h-16 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                        <LoadingDots />
                      </div>
                      <h3 className="text-lg font-medium mb-2">Awaiting Confirmation</h3>
                      {/* Transaction Details */}
                      {(() => {
                        const details = isDebugZap ? debugTxDetails : pendingTxDetails;
                        return details && (
                          <div className="flex items-center gap-2 mb-3 px-4 py-2 bg-[var(--muted)] rounded-lg">
                            <img src={details.fromLogo} alt={details.fromSymbol} className="w-5 h-5 rounded-full" />
                            <span className="mono text-sm">{details.fromAmount} {details.fromSymbol}</span>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--muted-foreground)]">
                              <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                            <img src={details.toLogo} alt={details.toSymbol} className="w-5 h-5 rounded-full" />
                            <span className="mono text-sm">{details.toAmount} {details.toSymbol}</span>
                          </div>
                        );
                      })()}
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                        Your zap {isDebugZapIn ? "in" : isDebugZapOut ? "out" : (zapDirection === "in" ? "in" : "out")} transaction is being confirmed on-chain.
                      </p>
                      <a
                        href={`https://etherscan.io/tx/${zapHash || debugHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}

                  {/* Transaction Success State - Zap */}
                  {isVaultDeployed && ((isDebugZap && isDebugSuccess) || (showTxSuccess?.show && showTxSuccess.type === "zap")) && (
                    <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
                      <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                        <Check className="w-8 h-8 text-green-500" />
                      </div>
                      <h3 className="text-lg font-medium mb-2 text-green-500">Zap Successful</h3>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                        Your transaction has been confirmed.
                      </p>
                      <a
                        href={`https://etherscan.io/tx/${showTxSuccess?.hash || debugHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}

                  {/* Transaction Reverted State - Zap */}
                  {isVaultDeployed && ((isDebugZap && isDebugReverted) || (showTxReverted?.show && showTxReverted.type === "zap")) && (
                    <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in zoom-in-95 duration-300">
                      <div className="w-16 h-16 rounded-full bg-[var(--destructive)]/20 flex items-center justify-center mb-4">
                        <X className="w-8 h-8 text-[var(--destructive)]" />
                      </div>
                      <h3 className="text-lg font-medium mb-2 text-[var(--destructive)]">Zap Failed</h3>
                      <p className="text-sm text-[var(--muted-foreground)] max-w-xs mb-4">
                        Transaction reverted on-chain.
                      </p>
                      <a
                        href={`https://etherscan.io/tx/${showTxReverted?.hash || debugHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-[var(--foreground)] hover:text-[var(--accent)] transition-colors mono"
                      >
                        View on Etherscan
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  )}

                  {/* Zap Form - hidden during pending/success/reverted states and multi-step approval */}
                  {isVaultDeployed && activeTab === "zap" && !isDebugZap && !isDebugDeposit && !isDebugWithdraw && zapStatus !== "waitingTx" && !pendingMultiStep?.type && !(showTxSuccess?.show && showTxSuccess.type === "zap") && !(showTxReverted?.show && showTxReverted.type === "zap") && (
                    <>
                      {/* Direction Toggle + Settings */}
                      <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--muted)] border border-[var(--border)]">
                        <button
                          onClick={() => {
                            setZapDirection("in");
                            setZapAmount("");
                          }}
                          className={cn(
                            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
                            zapDirection === "in"
                              ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          )}
                        >
                          Zap In
                        </button>
                        <button
                          onClick={() => {
                            setZapDirection("out");
                            setZapAmount("");
                          }}
                          className={cn(
                            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
                            zapDirection === "out"
                              ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          )}
                        >
                          Zap Out
                        </button>
                      </div>

                      {/* Zap In */}
                      {zapDirection === "in" && (
                        <>
                          {/* Input Token + Amount */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">Amount</span>
                              <span className="text-xs mono text-[var(--muted-foreground)]">{zapInputBalanceNum.toFixed(4)}</span>
                            </div>
                            <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={zapAmount}
                                onChange={(e) => setZapAmount(e.target.value)}
                                placeholder="0.00"
                                className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                              />
                              <TokenSelector
                                selectedToken={zapInputToken}
                                onSelect={handleZapInputTokenChange}
                                excludeTokens={[...excludedZapAddresses]}
                              />
                              <MaxButton
                                balance={zapInputMaxFormatted}
                                onSelect={setZapAmount}
                              />
                            </div>
                          </div>

                          {/* Arrow */}
                          <div className="flex justify-center">
                            <div className="w-8 h-8 rounded-full bg-[var(--muted)] flex items-center justify-center">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                                <path d="M12 5v14M19 12l-7 7-7-7" />
                              </svg>
                            </div>
                          </div>

                          {/* Output */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">You receive</span>
                            </div>
                            <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2">
                              <span className="mono text-base text-[var(--foreground)] flex-1">
                                {zapQuoteLoading ? "—" : zapQuote ? Number(zapQuote.outputAmountFormatted).toFixed(4) : "0.00"}
                              </span>
                              <span className="mono text-sm font-medium shrink-0">{vault.symbol}</span>
                            </div>
                          </div>
                        </>
                      )}

                      {/* Zap Out */}
                      {zapDirection === "out" && (
                        <>
                          {/* Input - Vault Shares */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">Amount</span>
                              <span className="text-xs mono text-[var(--muted-foreground)]">{vaultBalance.toFixed(4)}</span>
                            </div>
                            <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2 focus-within:ring-2 focus-within:ring-[var(--accent)] transition-shadow">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={zapAmount}
                                onChange={(e) => setZapAmount(e.target.value)}
                                placeholder="0.00"
                                className="flex-1 min-w-0 bg-transparent mono text-base outline-none ring-0 focus:outline-none focus:ring-0 placeholder:text-[var(--muted-foreground)]/50"
                              />
                              <span className="mono text-sm font-medium shrink-0">{vault.symbol}</span>
                              <MaxButton
                                balance={vaultBalanceMax}
                                onSelect={setZapAmount}
                              />
                            </div>
                          </div>

                          {/* Arrow */}
                          <div className="flex justify-center">
                            <div className="w-8 h-8 rounded-full bg-[var(--muted)] flex items-center justify-center">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                                <path d="M12 5v14M19 12l-7 7-7-7" />
                              </svg>
                            </div>
                          </div>

                          {/* Output Token */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-[var(--muted-foreground)]">You receive</span>
                            </div>
                            <div className="bg-[var(--muted)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-2">
                              <span className="mono text-base text-[var(--foreground)] flex-1">
                                {zapQuoteLoading ? "—" : zapQuote ? Number(zapQuote.outputAmountFormatted).toFixed(4) : "0.00"}
                              </span>
                              <TokenSelector
                                selectedToken={zapOutputToken}
                                onSelect={handleZapOutputTokenChange}
                                excludeTokens={[...excludedZapAddresses, ...EXTERNAL_VAULT_TOKENS.filter(a => a.toLowerCase() !== CURVE_SAVINGS.SCRVUSD.toLowerCase())]}
                              />
                            </div>
                          </div>
                        </>
                      )}

                      {/* Zap Details - always render to prevent layout shift */}
                      <div className={cn(
                        "space-y-2 text-sm",
                        !zapQuote && "invisible"
                      )}>
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Rate</span>
                          {zapQuote ? (
                            <button
                              type="button"
                              onClick={() => setRateInverted(v => !v)}
                              className="flex items-center gap-1 mono hover:text-[var(--accent)] transition-colors"
                            >
                              {rateInverted
                                ? <>1 {zapDirection === "in" ? vault.symbol : zapOutputToken?.symbol} = {(1 / zapQuote.exchangeRate).toFixed(4)} {zapDirection === "in" ? zapInputToken?.symbol : vault.symbol}</>
                                : <>1 {zapDirection === "in" ? zapInputToken?.symbol : vault.symbol} = {zapQuote.exchangeRate.toFixed(4)} {zapDirection === "in" ? vault.symbol : zapOutputToken?.symbol}</>
                              }
                              <ArrowRightLeft size={12} className="text-[var(--muted-foreground)]" />
                            </button>
                          ) : (
                            <span className="mono">—</span>
                          )}
                        </div>
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Price Impact</span>
                          <span className={cn(
                            "mono",
                            zapQuote && (zapQuote.priceImpact ?? 0) < 0
                              ? "text-green-500"
                              : zapQuote && (zapQuote.priceImpact ?? 0) > 2
                                ? "text-[var(--destructive)]"
                                : zapQuote && (zapQuote.priceImpact ?? 0) > 1
                                  ? "text-[var(--warning)]"
                                  : ""
                          )}>
                            {zapQuote?.priceImpact != null ? `${zapQuote.priceImpact.toFixed(2)}%` : "—"}
                          </span>
                        </div>
                        {/* Show value - for zap in, use output (vault shares) × underlying price */}
                        <div className="flex items-center justify-between py-1">
                          <span className="text-[var(--muted-foreground)]">Value</span>
                          <span className="mono">
                            {zapQuote ? (
                              <>~${(
                                zapDirection === "in"
                                  ? Number(zapQuote.outputAmountFormatted) * pricePerShare * underlyingPrice
                                  : Number(zapAmount) * pricePerShare * underlyingPrice
                              ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                            ) : (
                              "—"
                            )}
                          </span>
                        </div>
                      </div>

                      {/* Zap Approval Card */}
                      <ApprovalCard
                        show={showZapApprovalCard}
                        pendingApproval={lastZapApprovalRef.current}
                        approvalProgress={zapApprovalProgress}
                        decimals={zapDirection === "in" ? (zapInputToken?.decimals ?? 18) : 18}
                        isApproving={zapIsApproving}
                        onApprove={(exact) => zapApprove(exact)}
                      />

                      {/* Zap Action Button */}
                      {isConnected ? (
                        <button
                          onClick={async () => {
                            if (showSimulationPreview && effectiveSimulationResult && !showSimulationModal && currentBlock === simulationBlock.current) {
                              // Re-open cached simulation modal if same block
                              setShowSimulationModal(true);
                            } else if (showSimulationPreview) {
                              // Preview mode - run simulation first
                              const result = await runSimulationPreview();
                              if (result) return; // Modal opened — bail
                              // No simulation data (e.g. Anvil) — fall through to execute
                              setZapPendingDetails();
                              if (vault && zapAmount) trackZapInitiated(vault.id, zapDirection, zapDirection === "in" ? (zapInputToken?.symbol ?? "") : vault.symbol, zapDirection === "in" ? vault.symbol : (zapOutputToken?.symbol ?? ""), zapAmount);
                              executeZap();
                            } else if ((zapQuote?.priceImpact ?? 0) >= PRICE_IMPACT_CONFIRM_THRESHOLD) {
                              // High price impact - show confirmation modal
                              setPriceImpactConfirmText("");
                              setShowPriceImpactModal(true);
                            } else {
                              setZapPendingDetails();
                              if (vault && zapAmount) trackZapInitiated(vault.id, zapDirection, zapDirection === "in" ? (zapInputToken?.symbol ?? "") : vault.symbol, zapDirection === "in" ? vault.symbol : (zapOutputToken?.symbol ?? ""), zapAmount);
                              executeZap();
                            }
                          }}
                          disabled={showZapApprovalCard || !zapQuote || zapIsLoading || zapQuoteLoading || isSimulatingPreview || showSimulationModal || hasZapInsufficientBalance}
                          className={cn(
                            "w-full py-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-base",
                            showZapApprovalCard || !zapQuote || zapIsLoading || zapQuoteLoading || isSimulatingPreview || showSimulationModal || (zapAmount && hasZapInsufficientBalance)
                              ? "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                              : "bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 cursor-pointer"
                          )}
                        >
                          {isSimulatingPreview || showSimulationModal ? (
                            <>Simulating<LoadingDots /></>
                          ) : zapIsLoading ? (
                            <>Confirm in wallet<LoadingDots /></>
                          ) : zapQuoteLoading ? (
                            <>Getting quote<LoadingDots /></>
                          ) : !zapAmount || Number(zapAmount) === 0 ? (
                            "Enter amount"
                          ) : hasZapInsufficientBalance ? (
                            "Insufficient balance"
                          ) : !zapQuote ? (
                            "No route found"
                          ) : (
                            `Zap ${zapDirection === "in" ? "In" : "Out"}`
                          )}
                        </button>
                      ) : (
                        <button
                          onClick={openConnectModal}
                          className="w-full py-4 bg-[var(--foreground)] text-[var(--background)] rounded-lg font-medium hover:opacity-90 transition-all cursor-pointer"
                        >
                          Connect Wallet
                        </button>
                      )}

                      {/* Enso Attribution + Route Toggle + Slippage Settings */}
                      <div className="flex items-center justify-between pt-2">
                        <a
                          href="https://www.enso.build"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                        >
                          <span>Powered by</span>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/enso.png" alt="Enso" width={14} height={14} className="rounded-sm" />
                          <span className="font-medium">Enso</span>
                        </a>
                        <div className="flex items-center gap-1">
                          {/* Route toggle */}
                          <button
                            onClick={toggleRoute}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                            title={showRoute ? "Hide route" : "Show route"}
                          >
                            {showRoute ? <RouteOff size={16} /> : <Route size={16} />}
                          </button>
                          {/* Slippage settings */}
                          <button
                            onClick={() => setShowSlippageModal(true)}
                            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors p-1"
                            title="Zap settings"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="4" y1="6" x2="20" y2="6" />
                              <circle cx="8" cy="6" r="2" />
                              <line x1="4" y1="18" x2="20" y2="18" />
                              <circle cx="16" cy="18" r="2" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* Route details panel */}
                      <div
                        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                        style={{ gridTemplateRows: showRoute && zapAmount && Number(zapAmount) > 0 && (zapQuote || zapQuoteLoading) ? "1fr" : "0fr" }}
                      >
                        <div className="overflow-hidden">
                          <div className="pt-3 mt-3 border-t border-[var(--border)]">
                            <div className="text-xs text-[var(--muted-foreground)] mb-2">Route</div>
                            <RouteDisplay
                              routeInfo={zapQuote?.routeInfo}
                              inputSymbol={zapDirection === "in" ? zapInputToken?.symbol : vault?.symbol}
                              outputSymbol={zapDirection === "in" ? vault?.symbol : zapOutputToken?.symbol}
                              inputAmount={zapAmount ? Number(zapAmount).toFixed(4) : undefined}
                              outputAmount={zapQuote?.outputAmountFormatted ? Number(zapQuote.outputAmountFormatted).toFixed(4) : undefined}
                              isLoading={zapQuoteLoading}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <Footer />

      {/* Settings Modal */}
      <SlippageModal
        open={showSlippageModal}
        onClose={() => {
          setShowSlippageModal(false);
          refreshSimulationPreview();
        }}
        slippage={zapSlippage}
        onSlippageChange={updateSlippage}
        title={activeTab === "zap" ? "Zap Settings" : "Settings"}
      />

      {/* Price Impact Confirmation Modal */}
      {showPriceImpactModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowPriceImpactModal(false)}
          />
          <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-xl w-full max-w-sm p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-[var(--destructive)]">High Price Impact Warning</h3>
              <button
                onClick={() => setShowPriceImpactModal(false)}
                className="p-1 hover:bg-[var(--muted)] rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 rounded-lg p-4">
              <p className="text-sm text-[var(--foreground)]">
                This transaction has a <span className="font-bold text-[var(--destructive)]">{zapQuote?.priceImpact?.toFixed(2)}%</span> price impact.
                You may receive significantly less value than expected.
              </p>
            </div>

            <p className="text-sm text-[var(--muted-foreground)]">
              Type <span className="font-mono font-bold text-[var(--foreground)]">CONFIRM</span> below to acknowledge the risk and proceed.
            </p>

            <input
              type="text"
              value={priceImpactConfirmText}
              onChange={(e) => setPriceImpactConfirmText(e.target.value.toUpperCase())}
              placeholder="Type CONFIRM"
              className="w-full bg-[var(--muted)] rounded-lg p-3 mono text-base focus:outline-none focus:ring-2 focus:ring-[var(--destructive)] placeholder:text-[var(--muted-foreground)]/50"
              autoFocus
            />

            <div className="flex gap-3">
              <button
                onClick={() => setShowPriceImpactModal(false)}
                className="flex-1 py-3 rounded-lg font-medium transition-all bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--muted)]/80"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowPriceImpactModal(false);
                  setPriceImpactConfirmText("");
                  setZapPendingDetails();
                  if (vault && zapAmount) trackZapInitiated(vault.id, zapDirection, zapDirection === "in" ? (zapInputToken?.symbol ?? "") : vault.symbol, zapDirection === "in" ? vault.symbol : (zapOutputToken?.symbol ?? ""), zapAmount);
                  if (skipSimulationOnConfirm) {
                    setSkipSimulationOnConfirm(false);
                    executeZap({ skipSimulation: true });
                  } else {
                    executeZap();
                  }
                }}
                disabled={priceImpactConfirmText !== "CONFIRM"}
                className={cn(
                  "flex-1 py-3 rounded-lg font-medium transition-all",
                  priceImpactConfirmText === "CONFIRM"
                    ? "bg-[var(--destructive)] text-white hover:opacity-90 cursor-pointer"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed"
                )}
              >
                Zap {zapDirection === "in" ? "In" : "Out"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Simulation Modal (Zap only — deposit/withdraw has its own modal inline) */}
      {activeTab === "zap" && showSimulationModal && effectiveSimulationResult && (
        <SimulationModal
          isOpen={showSimulationModal}
          onClose={() => setShowSimulationModal(false)}
          onConfirm={() => {
            setShowSimulationModal(false);
            // Check price impact before executing
            if ((zapQuote?.priceImpact ?? 0) >= PRICE_IMPACT_CONFIRM_THRESHOLD) {
              setPriceImpactConfirmText("");
              setSkipSimulationOnConfirm(true);
              setShowPriceImpactModal(true);
            } else {
              setZapPendingDetails();
              executeZap({ skipSimulation: true });
            }
          }}
          simulationResult={{
            success: effectiveSimulationResult.success,
            gasUsed: effectiveSimulationResult.gasUsed ?? null,
            errorMessage: effectiveSimulationResult.errorMessage ?? null,
            tenderlyUrl: effectiveSimulationResult.tenderlyUrl ?? null,
            assetChanges: effectiveSimulationResult.assetChanges as SimulationAssetChange[],
          }}
          gasPrice={gasPrice}
          ethPrice={ethPrice}
          confirmText="Confirm Zap"
        />
      )}

      {/* Contract Explorer Modal */}
      <ContractExplorer
        address={explorerAddress}
        isOpen={explorerOpen}
        onClose={closeExplorer}
        title={explorerTitle}
        lastUpdated={explorerLastUpdated}
        icon={explorerIcon}
        showFlowTab={explorerShowFlowTab}
        activeTab={explorerActiveTab}
        onTabChange={setExplorerActiveTab}
        availableContracts={explorerContracts}
        onContractChange={(contract) => switchContract(contract.address, contract.title, contract.icon, contract.showFlowTab)}
      />

      {/* DEBUG: Transaction State Preview Panel - Only shows in development */}
      {process.env.NODE_ENV === "development" && (
        <div
          data-debug-panel
          className={cn(
            "fixed z-50 bg-[var(--card)] border border-[var(--border)] rounded-lg p-3 shadow-lg max-w-xs",
            isDragging && "cursor-grabbing"
          )}
          style={debugPanelPos ? {
            left: debugPanelPos.x,
            top: debugPanelPos.y,
            bottom: "auto",
            right: "auto",
          } : {
            bottom: 16,
            right: 16,
          }}
        >
          <div
            className="text-xs text-[var(--muted-foreground)] mb-2 font-medium cursor-grab select-none flex items-center justify-between"
            onMouseDown={handleDragStart}
          >
            <span>⋮⋮ TX State Preview</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleDebugMinimized(); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="ml-2 px-1.5 py-0.5 rounded hover:bg-[var(--muted)] transition-colors text-[10px]"
            >
              {debugMinimized ? "+" : "−"}
            </button>
          </div>
          {!debugMinimized && <div className="space-y-2">
            {/* Reset */}
            <button
              onClick={() => {
                setDebugTxState("none");
                setPendingMultiStep(null);
                setPendingTxDetails(null);
                setDebugSimulationResult(null);
                setShowSimulationModal(false);
                setShowSlippageModal(false);
                setShowPriceImpactModal(false);
                setPriceImpactConfirmText("");
              }}
              className={cn(
                "w-full px-2 py-1 text-xs rounded transition-colors",
                debugTxState === "none" && !pendingMultiStep && !showSimulationModal && !showSlippageModal && !showPriceImpactModal
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
            >
              Reset All
            </button>
            {/* Deposit */}
            <div className="flex gap-1">
              <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">Deposit</span>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("deposit-pending"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "deposit-pending"
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Pending
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("deposit-success"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "deposit-success"
                    ? "bg-green-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Success
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("deposit-reverted"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "deposit-reverted"
                    ? "bg-red-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Reverted
              </button>
            </div>
            {/* Withdraw */}
            <div className="flex gap-1">
              <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">Withdraw</span>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("withdraw-pending"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "withdraw-pending"
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Pending
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("withdraw-success"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "withdraw-success"
                    ? "bg-green-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Success
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("withdraw-reverted"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "withdraw-reverted"
                    ? "bg-red-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Reverted
              </button>
            </div>
            {/* Zap Approve (multi-step) */}
            <div className="flex gap-1">
              <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">Approve</span>
              <button
                onClick={() => {
                  setDebugTxState("none");
                  setPendingMultiStep({
                    type: "zap",
                    step: 1,
                    approvalToken: "USDC",
                    spenderName: "Enso",
                  });
                  setPendingTxDetails({
                    fromAmount: "123.31",
                    fromSymbol: "USDC",
                    fromLogo: "/tokens/usdc.png",
                    toAmount: "144.55",
                    toSymbol: vault?.symbol || "yspxCVX",
                    toLogo: vault?.logo || "/tokens/unknown.png",
                  });
                }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  pendingMultiStep?.step === 1
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Step 1
              </button>
              <button
                onClick={() => {
                  setPendingMultiStep({
                    type: "zap",
                    step: 2,
                    approvalToken: "USDC",
                    spenderName: "Enso",
                  });
                  setPendingTxDetails({
                    fromAmount: "123.31",
                    fromSymbol: "USDC",
                    fromLogo: "/tokens/usdc.png",
                    toAmount: "144.55",
                    toSymbol: vault?.symbol || "yspxCVX",
                    toLogo: vault?.logo || "/tokens/unknown.png",
                  });
                  setDebugTxState("zap-in-pending");
                }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  pendingMultiStep?.step === 2
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Step 2
              </button>
              <button
                onClick={() => {
                  setDebugTxState("none");
                  setPendingMultiStep(null);
                  setPendingTxDetails(null);
                }}
                className="flex-1 px-2 py-1 text-xs rounded transition-colors bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Clear
              </button>
            </div>
            {/* Zap In */}
            <div className="flex gap-1">
              <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">Zap In</span>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("zap-in-pending"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "zap-in-pending"
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Pending
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("zap-in-success"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "zap-in-success"
                    ? "bg-green-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Success
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("zap-in-reverted"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "zap-in-reverted"
                    ? "bg-red-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Reverted
              </button>
            </div>
            {/* Zap Out */}
            <div className="flex gap-1">
              <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">Zap Out</span>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("zap-out-pending"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "zap-out-pending"
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Pending
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("zap-out-success"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "zap-out-success"
                    ? "bg-green-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Success
              </button>
              <button
                onClick={() => { setPendingMultiStep(null); setPendingTxDetails(null); setDebugTxState("zap-out-reverted"); }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  debugTxState === "zap-out-reverted"
                    ? "bg-red-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Reverted
              </button>
            </div>
            {/* Separator */}
            <div className="border-t border-[var(--border)] my-2" />
            {/* Modals */}
            <div className="flex gap-1">
              <span className="text-[10px] text-[var(--muted-foreground)] w-14 flex items-center">Modals</span>
              <button
                onClick={() => setShowSlippageModal(!showSlippageModal)}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  showSlippageModal
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Slippage
              </button>
              <button
                onClick={() => {
                  if (showSimulationModal) {
                    setShowSimulationModal(false);
                    setDebugSimulationResult(null);
                  } else {
                    setDebugSimulationResult({
                      success: true,
                      gasUsed: 285000,
                      tenderlyUrl: "https://dashboard.tenderly.co/shared/simulation/example",
                      assetChanges: [
                        { type: "send", symbol: "USDC", amount: "100.00", logo: "/tokens/usdc.png" },
                        { type: "receive", symbol: vault?.symbol || "ycvxCRV", amount: "95.50", logo: vault?.logo },
                      ],
                    });
                    setShowSimulationModal(true);
                  }
                }}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  showSimulationModal
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Simulate
              </button>
              <button
                onClick={() => setShowPriceImpactModal(!showPriceImpactModal)}
                className={cn(
                  "flex-1 px-2 py-1 text-xs rounded transition-colors",
                  showPriceImpactModal
                    ? "bg-red-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                Impact
              </button>
            </div>
            {/* Separator */}
            <div className="border-t border-[var(--border)] my-2" />
            {/* Auto Cycle Controls */}
            <div className="space-y-2">
              <button
                onClick={() => setDebugAutoCycle(!debugAutoCycle)}
                className={cn(
                  "w-full px-2 py-1 text-xs rounded transition-colors",
                  debugAutoCycle
                    ? "bg-blue-500 text-white"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                {debugAutoCycle ? "⏸ Stop Auto-Cycle" : "▶ Auto-Cycle All"}
              </button>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--muted-foreground)]">Speed</span>
                <input
                  type="range"
                  min="500"
                  max="3000"
                  step="250"
                  value={debugCycleSpeed}
                  onChange={(e) => setDebugCycleSpeed(Number(e.target.value))}
                  className="flex-1 h-1 accent-[var(--accent)]"
                />
                <span className="text-[10px] text-[var(--muted-foreground)] w-10">{(debugCycleSpeed / 1000).toFixed(1)}s</span>
              </div>
            </div>
          </div>}
        </div>
      )}

    </div>
  );
}
