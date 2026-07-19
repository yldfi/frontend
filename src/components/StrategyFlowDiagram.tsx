"use client";

import { useMemo, useEffect, useCallback, useState } from "react";
import {
  ReactFlow,
  Node,
  Edge,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
  ReactFlowProvider,
  Panel,
  ConnectionLineType,
  useReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getBezierPath,
  EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StrategyFlowConfig } from "@/lib/strategy-flow/types";
import { getVaultByAddress } from "@/config/vaults";
import { Info, Wallet, Database, Gavel, Bot, ArrowDownUp, User, Gift } from "lucide-react";

// Known protocol logos
const PROTOCOL_LOGOS: Record<string, string> = {
  convex: "https://assets.coingecko.com/coins/images/15585/thumb/convex.png",
  yearn: "https://assets.coingecko.com/coins/images/11849/thumb/yearn.jpg",
  aave: "https://assets.coingecko.com/coins/images/12645/thumb/aave-token-round.png",
  compound: "https://assets.coingecko.com/coins/images/10775/thumb/COMP.png",
  curve: "https://assets.coingecko.com/coins/images/12124/thumb/Curve.png",
  liquidboost: "/tokens/liquidboost.png",
};

// Get logo for a yield source based on name
function getYieldSourceLogo(name: string, contractName?: string | null): string | undefined {
  const nameLower = name.toLowerCase();
  const contractLower = contractName?.toLowerCase() || "";

  // LiquidBoost / Tangent / CvgCvx staking (check first - more specific)
  if (
    nameLower.includes("liquidboost") ||
    nameLower.includes("tangent") ||
    contractLower.includes("cvgcvxstaking") ||
    contractLower.includes("liquidboost")
  ) {
    return PROTOCOL_LOGOS.liquidboost;
  }
  // Convex (but not cvgCVX which is Convergence/Tangent)
  if ((nameLower.includes("convex") || nameLower.includes("cvx") || nameLower === "wrapper") &&
      !nameLower.includes("cvgcvx") && !contractLower.includes("cvgcvx")) {
    return PROTOCOL_LOGOS.convex;
  }
  if (nameLower.includes("yearn") || nameLower.includes("yvault")) {
    return PROTOCOL_LOGOS.yearn;
  }
  if (nameLower.includes("aave")) {
    return PROTOCOL_LOGOS.aave;
  }
  if (nameLower.includes("compound") || nameLower.includes("cusdc")) {
    return PROTOCOL_LOGOS.compound;
  }
  if (nameLower.includes("curve") || nameLower.includes("crv")) {
    return PROTOCOL_LOGOS.curve;
  }
  return undefined;
}

// Etherscan link helper
function etherscanLink(address: string): string {
  return `https://etherscan.io/address/${address}`;
}

// Format address for display (full address, no truncation)
function formatAddr(address: string): string {
  if (!address) return "";
  return address;
}

interface NodeData {
  title: string;
  subtitle?: string;
  address?: string;
  description?: string;
  items?: string[];
  isActive?: boolean;
  onClick?: () => void;
  color: "accent" | "green" | "cyan" | "blue" | "muted";
  icon?: React.ReactNode;
}

// Color schemes matching the app's dark theme
const colorSchemes = {
  accent: {
    bg: "var(--muted)",
    border: "var(--accent)",
    text: "var(--accent)",
    handle: "#f59e0b",
  },
  green: {
    bg: "var(--muted)",
    border: "var(--success)",
    text: "var(--success)",
    handle: "#22c55e",
  },
  cyan: {
    bg: "var(--muted)",
    border: "var(--rainbow-cyan)",
    text: "var(--rainbow-cyan)",
    handle: "#06b6d4",
  },
  blue: {
    bg: "var(--muted)",
    border: "var(--rainbow-blue)",
    text: "var(--rainbow-blue)",
    handle: "#3b82f6",
  },
  muted: {
    bg: "var(--muted)",
    border: "var(--border)",
    text: "var(--muted-foreground)",
    handle: "#52525b",
  },
};

// Custom node component
function StrategyNode({ data }: { data: NodeData }) {
  const colors = colorSchemes[data.color];

  return (
    <>
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "30%" }}
      />
      <Handle
        type="target"
        id="left-bottom"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "70%" }}
      />
      <Handle
        type="target"
        id="right"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "30%" }}
      />

      <div
        className="min-w-[220px] rounded-lg border shadow-lg cursor-pointer transition-all duration-200 hover:border-[var(--border-hover)]"
        style={{
          background: colors.bg,
          borderColor: colors.border,
          borderWidth: "1px",
        }}
        onClick={data.onClick}
      >
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold flex items-center gap-2" style={{ color: colors.text }}>
              {data.icon}
              {data.title}
            </div>
            <Info className="h-4 w-4 opacity-40" style={{ color: "var(--muted-foreground)" }} />
          </div>

          {data.subtitle && (
            <div className="text-xs font-medium mb-1" style={{ color: colors.text }}>{data.subtitle}</div>
          )}

          {data.address && (
            <a
              href={etherscanLink(data.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono hover:underline block mb-2"
              style={{ color: "var(--accent)" }}
              onClick={(e) => e.stopPropagation()}
            >
              {formatAddr(data.address)}
            </a>
          )}

          {data.description && (
            <div className="text-xs mb-2" style={{ color: "var(--muted-foreground)" }}>{data.description}</div>
          )}

          {data.items && data.items.length > 0 && (
            <div className="space-y-1">
              {data.items.map((item, i) => (
                <div
                  key={i}
                  className="text-xs font-mono px-2 py-1 rounded"
                  style={{
                    background: "var(--background)",
                    color: "var(--muted-foreground)",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="source"
        id="left"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "30%" }}
      />
      <Handle
        type="source"
        id="left-bottom"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "70%" }}
      />
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "70%" }}
      />
    </>
  );
}

// User node (special styling with accent border)
interface UserNodeData extends NodeData {
  onHoverDeposit?: (hovering: boolean) => void;
  onHoverWithdraw?: (hovering: boolean) => void;
}

function UserNode({ data }: { data: UserNodeData }) {
  const colors = colorSchemes[data.color];

  // Split items into deposit (before ---) and withdraw (after ---) sections
  const separatorIndex = data.items?.indexOf("---") ?? -1;
  const depositItems = separatorIndex > 0 ? data.items?.slice(0, separatorIndex) : [];
  const withdrawItems = separatorIndex > 0 ? data.items?.slice(separatorIndex + 1) : [];

  return (
    <>
      {/* Target handles for receiving flows */}
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="target"
        id="right-bottom"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "70%" }}
      />

      <div
        className="min-w-[180px] rounded-lg border-2 shadow-lg cursor-pointer transition-all duration-200"
        style={{
          background: colors.bg,
          borderColor: colors.border,
        }}
        onClick={data.onClick}
      >
        <div className="p-3">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Wallet className="h-5 w-5" style={{ color: colors.text }} />
            <div className="text-sm font-semibold" style={{ color: colors.text }}>{data.title}</div>
          </div>

          {/* Deposit/Mint section */}
          {depositItems && depositItems.length > 0 && (
            <div
              className="space-y-1 relative"
              onMouseEnter={() => data.onHoverDeposit?.(true)}
              onMouseLeave={() => data.onHoverDeposit?.(false)}
            >
              {/* Pulsing hover indicator */}
              <div
                className="absolute -top-1 -right-1 w-2 h-2 rounded-full animate-pulse"
                style={{ background: "#22c55e", boxShadow: "0 0 6px #22c55e" }}
                title="Hover to animate"
              />
              {depositItems.map((item, i) => (
                <div
                  key={i}
                  className="text-xs font-mono px-2 py-1 rounded text-center"
                  style={{
                    background: "var(--background)",
                    color: "var(--muted-foreground)",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          )}

          {/* Separator */}
          {separatorIndex > 0 && (
            <div
              className="border-t my-2"
              style={{ borderColor: "var(--border)" }}
            />
          )}

          {/* Withdraw/Redeem section */}
          {withdrawItems && withdrawItems.length > 0 && (
            <div
              className="space-y-1 relative"
              onMouseEnter={() => data.onHoverWithdraw?.(true)}
              onMouseLeave={() => data.onHoverWithdraw?.(false)}
            >
              {/* Pulsing hover indicator */}
              <div
                className="absolute -top-1 -right-1 w-2 h-2 rounded-full animate-pulse"
                style={{ background: "#f59e0b", boxShadow: "0 0 6px #f59e0b" }}
                title="Hover to animate"
              />
              {withdrawItems.map((item, i) => (
                <div
                  key={i}
                  className="text-xs font-mono px-2 py-1 rounded text-center"
                  style={{
                    background: "var(--background)",
                    color: "var(--muted-foreground)",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Source handle for deposit flow */}
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "30%" }}
      />
    </>
  );
}

// Keeper/Taker node (smaller)
interface KeeperNodeData extends NodeData {
  isPermissionless?: boolean;
}

function KeeperNode({ data }: { data: KeeperNodeData }) {
  const colors = colorSchemes[data.color];

  return (
    <>
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="w-2 h-2"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="source"
        id="left"
        position={Position.Left}
        className="w-2 h-2"
        style={{ background: colors.handle, border: "none" }}
      />

      <div
        className="min-w-[120px] rounded-lg border shadow-md cursor-pointer transition-all duration-200 hover:border-[var(--border-hover)] relative"
        style={{
          background: colors.bg,
          borderColor: colors.border,
        }}
        onClick={data.onClick}
      >
        {/* Pulsing hover indicator */}
        <div
          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full animate-pulse"
          style={{ background: colors.text, boxShadow: `0 0 6px ${colors.text}` }}
          title="Hover to animate"
        />
        <div className="p-2">
          <div className="flex items-center justify-center gap-1.5">
            {data.isPermissionless ? (
              <>
                <User className="h-4 w-4" style={{ color: colors.text }} />
                <span style={{ color: "var(--muted-foreground)", fontSize: "10px" }}>/</span>
                <Bot className="h-4 w-4" style={{ color: colors.text }} />
              </>
            ) : (
              <Bot className="h-4 w-4" style={{ color: colors.text }} />
            )}
            <div className="text-xs font-medium" style={{ color: colors.text }}>{data.title}</div>
          </div>
          {data.subtitle && (
            <div className="text-[10px] text-center mt-0.5" style={{ color: "var(--muted-foreground)" }}>
              {data.subtitle}
            </div>
          )}
          {data.address && (
            <a
              href={etherscanLink(data.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[9px] font-mono hover:underline block text-center mt-1 truncate max-w-[200px]"
              style={{ color: "var(--accent)" }}
              onClick={(e) => e.stopPropagation()}
              title={data.address}
            >
              {data.address}
            </a>
          )}
        </div>
      </div>

      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="w-2 h-2"
        style={{ background: colors.handle, border: "none" }}
      />
    </>
  );
}

// Auction node with internal token flow visualization
interface AuctionNodeData extends NodeData {
  rewardTokens: string[]; // e.g., ["CRV", "CVX", "crvUSD"]
  targetAsset: string; // e.g., "cvxCRV"
  isAnimating?: boolean; // Whether to animate the merging lines (taker hover)
  isKickAnimating?: boolean; // Whether to animate reward token buttons (kick hover)
}

function AuctionNode({ data }: { data: AuctionNodeData }) {
  const colors = colorSchemes[data.color];

  return (
    <>
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "50%" }}
      />

      <div
        className="rounded-xl border-2"
        style={{
          background: "var(--muted)",
          borderColor: colors.border,
          width: 280,
          padding: "12px",
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <Gavel className="h-4 w-4" style={{ color: colors.text }} />
          <div className="text-sm font-semibold" style={{ color: colors.text }}>
            {data.title}
          </div>
        </div>
        {data.subtitle && (
          <div className="text-[10px] mb-1" style={{ color: "var(--muted-foreground)" }}>
            {data.subtitle}
          </div>
        )}
        {data.address && (
          <a
            href={etherscanLink(data.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-mono hover:underline block mb-2"
            style={{ color: "var(--accent)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {data.address}
          </a>
        )}

        {/* Internal auction flow visualization */}
        <div className="mt-2 flex items-center justify-center gap-2">
          {/* Reward tokens (left side) */}
          <div className="flex flex-col gap-1">
            {data.rewardTokens.map((token) => (
              <div
                key={token}
                className="px-2 py-1 rounded text-[10px] font-mono border text-center"
                style={{
                  background: "var(--background)",
                  color: "#22c55e",
                  borderColor: "#22c55e",
                  borderStyle: data.isKickAnimating ? "dashed" : "solid",
                  minWidth: "50px",
                }}
              >
                {token}
              </div>
            ))}
          </div>

          {/* Arrows converging */}
          <div className="flex flex-col items-center justify-center" style={{ minWidth: "40px" }}>
            <svg width="40" height={Math.max(60, data.rewardTokens.length * 24)} viewBox={`0 0 40 ${Math.max(60, data.rewardTokens.length * 24)}`}>
              <style>
                {`
                  @keyframes dash {
                    to {
                      stroke-dashoffset: -20;
                    }
                  }
                `}
              </style>
              {data.rewardTokens.map((_, i) => {
                const totalTokens = data.rewardTokens.length;
                const totalHeight = Math.max(60, totalTokens * 24);
                const startY = (i * 24) + 12 + (totalHeight - totalTokens * 24) / 2;
                const endY = totalHeight / 2;
                return (
                  <path
                    key={i}
                    d={`M 0 ${startY} Q 20 ${startY} 30 ${endY}`}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2"
                    strokeDasharray={data.isAnimating ? "5,5" : "none"}
                    style={data.isAnimating ? { animation: "dash 0.5s linear infinite" } : undefined}
                  />
                );
              })}
              {/* Arrow head */}
              <polygon
                points={`30,${Math.max(60, data.rewardTokens.length * 24) / 2 - 4} 40,${Math.max(60, data.rewardTokens.length * 24) / 2} 30,${Math.max(60, data.rewardTokens.length * 24) / 2 + 4}`}
                fill="#f59e0b"
              />
            </svg>
          </div>

          {/* Target asset (right side) — minWidth set above the reward pills'
              50px floor so it reads as visually larger/more prominent
              regardless of how short the target symbol happens to be,
              instead of relying on padding-vs-minWidth math that only
              coincidentally differs from the reward pills for some tokens */}
          <div
            className="px-3 py-2 rounded text-[11px] font-mono border font-semibold text-center"
            style={{
              background: "var(--background)",
              color: "#a855f7",
              borderColor: "#a855f7",
              borderStyle: data.isAnimating ? "dashed" : "solid",
              minWidth: "70px",
            }}
          >
            {data.targetAsset}
          </div>
        </div>

        {data.description && (
          <div className="text-[9px] mt-2 text-center" style={{ color: "var(--muted-foreground)" }}>
            {data.description}
          </div>
        )}
      </div>

      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="source"
        id="left"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "70%" }}
      />
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "50%" }}
      />
    </>
  );
}

// Combined Strategy + Wrapper node (visually nested)
interface CombinedNodeData extends NodeData {
  wrapperTitle?: string;
  wrapperAddress?: string;
  wrapperFunction?: string; // e.g., "getReward()"
  wrapperDepositFn?: string; // e.g., "stake()" - for deploying funds
  wrapperWithdrawFn?: string; // e.g., "unstake()" - for freeing funds
  strategyFunction?: string; // e.g., "report()"
  strategyLogo?: string;
  wrapperLogo?: string;
  rewardTokens?: string; // e.g., "CRV + CVX"
  assetSymbol?: string; // e.g., "cvxCRV" - for deploy funds flow
  isAnimating?: boolean; // Whether to animate internal lines (keeper hover)
  isDepositAnimating?: boolean; // Whether to animate deposit flow
  isWithdrawAnimating?: boolean; // Whether to animate withdraw flow
  isKickAnimating?: boolean; // Whether to animate reward tokens (kick hover)
  isDirectCompounding?: boolean; // Whether rewards are same as asset (show purple compound line)
  isPassThrough?: boolean; // Whether strategy is pass-through (holds asset directly, no staking)
}

function CombinedStrategyNode({ data }: { data: CombinedNodeData }) {
  const colors = colorSchemes[data.color];
  const wrapperColors = colorSchemes["blue"];

  return (
    <>
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "20%" }}
      />
      <Handle
        type="target"
        id="left-bottom"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "80%" }}
      />
      <Handle
        type="target"
        id="right"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "20%" }}
      />
      <Handle
        type="target"
        id="right-mid"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "50%" }}
      />
      {/* Handle positioned at report() level for keeper connection */}
      <Handle
        type="target"
        id="right-report"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: "#06b6d4", border: "none", top: "32.3%" }}
      />

      <div
        className="rounded-xl border-2 relative"
        style={{
          background: "var(--muted)",
          borderColor: colors.border,
          width: 280,
          padding: "12px",
          overflow: "visible",
        }}
      >
        {/* Straight horizontal line at center of report() to right edge */}
        {data.strategyFunction && (
          <div
            className="absolute h-0.5"
            style={{
              background: data.isAnimating
                ? "repeating-linear-gradient(90deg, #06b6d4 0px, #06b6d4 5px, transparent 5px, transparent 10px)"
                : "#06b6d4",
              backgroundSize: data.isAnimating ? "10px 100%" : undefined,
              animation: data.isAnimating ? "dashMove 0.3s linear infinite" : undefined,
              top: "90px",
              right: "-2px",
              left: "72px",
              zIndex: 5,
            }}
          />
        )}
        {/* Keyframes for dash animation */}
        {data.isAnimating && (
          <style>
            {`
              @keyframes dashMove {
                from { background-position: 10px 0; }
                to { background-position: 0 0; }
              }
            `}
          </style>
        )}
        {/* Strategy header */}
        <div className="flex items-center gap-2 mb-1">
          {data.strategyLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.strategyLogo} alt="" className="w-5 h-5 rounded-full" />
          ) : (
            data.icon
          )}
          <div className="text-sm font-semibold" style={{ color: colors.text }}>
            {data.title}
          </div>
        </div>
        {data.subtitle && (
          <div className="text-[10px] mb-1" style={{ color: "var(--muted-foreground)" }}>
            {data.subtitle}
          </div>
        )}
        {data.address && (
          <a
            href={etherscanLink(data.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-mono hover:underline block mb-2"
            style={{ color: "var(--accent)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {data.address}
          </a>
        )}

        {/* Internal flow: report() → wrapper → getReward() */}
        {(data.strategyFunction || data.wrapperTitle) && (
          <div className="mt-1 space-y-0 relative" style={{ overflow: "visible" }}>
            {/* report() node with incoming connection line from keeper */}
            {data.strategyFunction && (
              <div className="flex items-center">
                <div
                  className="px-2 py-1 rounded text-[10px] font-mono border relative z-10"
                  style={{
                    background: "var(--background)",
                    color: "#06b6d4",
                    borderColor: "#06b6d4",
                    borderStyle: data.isAnimating ? "dashed" : "solid",
                  }}
                >
                  {data.strategyFunction}
                </div>
              </div>
            )}

            {/* _deployFunds() and _freeFunds() side by side */}
            {data.wrapperDepositFn && (
              <div className="flex gap-3 mt-2 mb-1">
                {/* _deployFunds() */}
                <div className="flex flex-col items-center">
                  <div
                    className="px-2 py-1 rounded text-[9px] font-mono border"
                    style={{
                      background: "var(--background)",
                      color: "#22c55e",
                      borderColor: "#22c55e",
                      borderStyle: (data.isDepositAnimating || data.isAnimating) ? "dashed" : "solid",
                    }}
                  >
                    _deployFunds()
                  </div>
                  <div
                    className="w-0.5 h-3"
                    style={{
                      background: (data.isDepositAnimating || data.isAnimating)
                        ? "repeating-linear-gradient(180deg, #22c55e 0px, #22c55e 5px, transparent 5px, transparent 10px)"
                        : "#22c55e",
                      animation: (data.isDepositAnimating || data.isAnimating) ? "dashMoveVertGreen 0.3s linear infinite" : undefined,
                    }}
                  />
                </div>

                {/* _freeFunds() */}
                {data.wrapperWithdrawFn && (
                  <div className="flex flex-col items-center">
                    <div
                      className="px-2 py-1 rounded text-[9px] font-mono border"
                      style={{
                        background: "var(--background)",
                        color: "#f59e0b",
                        borderColor: "#f59e0b",
                        borderStyle: data.isWithdrawAnimating ? "dashed" : "solid",
                      }}
                    >
                      _freeFunds()
                    </div>
                    <div
                      className="w-0.5 h-3"
                      style={{
                        background: data.isWithdrawAnimating
                          ? "repeating-linear-gradient(180deg, #f59e0b 0px, #f59e0b 5px, transparent 5px, transparent 10px)"
                          : "#f59e0b",
                        animation: data.isWithdrawAnimating ? "dashMoveVertOrange 0.3s linear infinite" : undefined,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            {/* Animation keyframes */}
            <style>
              {`
                @keyframes dashMoveVertGreen {
                  from { background-position: 0 0; }
                  to { background-position: 0 10px; }
                }
                @keyframes dashMoveVertOrange {
                  from { background-position: 0 10px; }
                  to { background-position: 0 0; }
                }
              `}
            </style>

            {/* Keyframes for vertical dash animation */}
            {data.isAnimating && (
              <style>
                {`
                  @keyframes dashMoveVert {
                    from { background-position: 0 0; }
                    to { background-position: 0 10px; }
                  }
                `}
              </style>
            )}

            {/* Nested wrapper box */}
            {data.wrapperTitle && (
              <div
                className={`rounded-lg border p-2 ${!data.wrapperDepositFn ? "mt-3" : ""}`}
                style={{
                  background: "var(--background)",
                  borderColor: wrapperColors.border,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  {data.wrapperLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={data.wrapperLogo} alt="" className="w-4 h-4 rounded-full" />
                  ) : (
                    <ArrowDownUp className="h-3 w-3" style={{ color: wrapperColors.text }} />
                  )}
                  <div className="text-xs font-medium" style={{ color: wrapperColors.text }}>
                    {data.wrapperTitle}
                  </div>
                </div>
                {data.wrapperAddress && (
                  <a
                    href={etherscanLink(data.wrapperAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[8px] font-mono hover:underline block mb-1"
                    style={{ color: "var(--accent)" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {data.wrapperAddress}
                  </a>
                )}

                {/* stake() and unstake() functions aligned with strategy functions above */}
                {data.wrapperDepositFn && (
                  <div className="flex gap-3 mb-2">
                    {/* stake() - receives from _deployFunds() */}
                    <div
                      className="px-2 py-1 rounded text-[8px] font-mono border"
                      style={{
                        background: "var(--muted)",
                        color: "#22c55e",
                        borderColor: "#22c55e",
                        borderStyle: (data.isDepositAnimating || data.isAnimating) ? "dashed" : "solid",
                      }}
                    >
                      {data.wrapperDepositFn}
                    </div>

                    {/* unstake() - called by _freeFunds() */}
                    {data.wrapperWithdrawFn && (
                      <div
                        className="px-2 py-1 rounded text-[8px] font-mono border"
                        style={{
                          background: "var(--muted)",
                          color: "#f59e0b",
                          borderColor: "#f59e0b",
                          borderStyle: data.isWithdrawAnimating ? "dashed" : "solid",
                        }}
                      >
                        {data.wrapperWithdrawFn}
                      </div>
                    )}
                  </div>
                )}

                {/* Connector line to getReward() */}
                {data.wrapperFunction && !data.wrapperDepositFn && (
                  <div className="flex items-center pl-2 py-2">
                    <div
                      className="w-0.5 h-4"
                      style={{
                        background: data.isAnimating
                          ? "repeating-linear-gradient(180deg, #06b6d4 0px, #06b6d4 5px, transparent 5px, transparent 10px)"
                          : "#06b6d4",
                        backgroundSize: data.isAnimating ? "100% 10px" : undefined,
                        animation: data.isAnimating ? "dashMoveVert 0.3s linear infinite" : undefined,
                      }}
                    />
                  </div>
                )}

                {/* Claim function node - full width for longer function names */}
                {data.wrapperFunction && (
                  <div className="w-full">
                    <div
                      className="px-2 py-1 rounded text-[9px] font-mono border w-full text-center"
                      style={{
                        background: "var(--muted)",
                        color: "#06b6d4",
                        borderColor: "#06b6d4",
                        borderStyle: data.isAnimating ? "dashed" : "solid",
                      }}
                    >
                      {data.wrapperFunction}
                    </div>
                  </div>
                )}

                {/* Rewards output from getReward() */}
                {data.wrapperFunction && data.rewardTokens && (
                  <>
                    {/* Connector line centered under claim button */}
                    <div className="flex justify-center w-full">
                      <div className="flex items-center py-1 justify-center">
                        <div
                          className="w-0.5 h-3"
                          style={{
                            background: data.isAnimating
                              ? "repeating-linear-gradient(180deg, #22c55e 0px, #22c55e 5px, transparent 5px, transparent 10px)"
                              : "#22c55e",
                            backgroundSize: data.isAnimating ? "100% 10px" : undefined,
                            animation: data.isAnimating ? "dashMoveVertGreen 0.3s linear infinite" : undefined,
                          }}
                        />
                      </div>
                    </div>
                    {data.isAnimating && (
                      <style>
                        {`
                          @keyframes dashMoveVertGreen {
                            from { background-position: 0 0; }
                            to { background-position: 0 10px; }
                          }
                          @keyframes dashMoveUp {
                            from { background-position: 0 10px; }
                            to { background-position: 0 0; }
                          }
                        `}
                      </style>
                    )}
                    {/* Reward token button with purple compound line going up to deposit */}
                    <div className="relative">
                      <div
                        className="px-2 py-1 rounded text-[9px] font-mono border flex items-center gap-1"
                        style={{
                          background: "var(--muted)",
                          color: "#22c55e",
                          borderColor: "#22c55e",
                          borderStyle: data.isKickAnimating ? "dashed" : "solid",
                        }}
                      >
                        <Gift className="h-3 w-3" />
                        <span>{data.rewardTokens}</span>
                      </div>
                      {/* Purple vertical line going up to deposit() - compound flow - only for direct compounding strategies on keeper hover */}
                      {data.isAnimating && data.isDirectCompounding && (
                        <div
                          className="absolute"
                          style={{
                            left: "24px",
                            top: "-47px",
                            width: "2px",
                            height: "40px",
                            background: "repeating-linear-gradient(180deg, #a855f7 0px, #a855f7 5px, transparent 5px, transparent 10px)",
                            backgroundSize: "100% 10px",
                            animation: "dashMoveUp 0.3s linear infinite",
                          }}
                        />
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none" }}
      />
      {/* Wrapper output - where rewards flow out */}
      <Handle
        type="source"
        id="wrapper-out"
        position={Position.Bottom}
        className="w-3 h-3"
        style={{ background: "#06b6d4", border: "none", left: "80%" }}
      />
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "80%" }}
      />
      <Handle
        type="source"
        id="left-mid"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "50%" }}
      />
      <Handle
        type="source"
        id="left-bottom"
        position={Position.Left}
        className="w-3 h-3"
        style={{ background: colors.handle, border: "none", top: "80%" }}
      />
    </>
  );
}

const nodeTypes = {
  strategy: StrategyNode,
  user: UserNode,
  keeper: KeeperNode,
  combinedStrategy: CombinedStrategyNode,
  auction: AuctionNode,
};

// Custom edge with multi-line label support
function MultiLineLabelEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.lines && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="flex flex-col items-center text-[10px] font-medium text-[#a1a1aa] bg-[#18181b] px-2 py-1 rounded"
          >
            {(data.lines as string[]).map((line: string, i: number) => (
              <span key={i}>{line}</span>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function MultiLineLabelSmoothStepEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.lines && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="flex flex-col items-center text-[10px] font-medium text-[#a1a1aa] bg-[#18181b] px-2 py-1 rounded"
          >
            {(data.lines as string[]).map((line: string, i: number) => (
              <span key={i}>{line}</span>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = {
  multiLineLabel: MultiLineLabelEdge,
  multiLineLabelSmoothStep: MultiLineLabelSmoothStepEdge,
};

// Edge label styling helper
function createEdgeStyle(color: string, animated: boolean = false) {
  return {
    style: { stroke: color, strokeWidth: 2 },
    labelBgPadding: [8, 4] as [number, number],
    labelBgBorderRadius: 4,
    labelBgStyle: { fill: "#18181b", fillOpacity: 0.95 },
    labelStyle: { fill: "#a1a1aa", fontWeight: 500, fontSize: 10, whiteSpace: "pre-line" as const },
    markerEnd: { type: MarkerType.ArrowClosed, color },
    animated,
  };
}

interface StrategyFlowDiagramProps {
  config: StrategyFlowConfig;
}

function StrategyFlowDiagramInner({ config }: StrategyFlowDiagramProps) {
  const hasAuction = config.compounding.mechanism === "auction";
  const isDirect = config.compounding.mechanism === "direct";
  const isPassThrough = config.yieldSource.depositFn === "hold";

  const assetSymbol = config.asset.symbol || "ASSET";
  const yieldSourceName = config.yieldSource.name || "Yield Source";
  const rewardTokens = config.rewards.tokens.length > 0
    ? config.rewards.tokens.join(" + ")
    : "REWARDS";

  // Fetch wrapper contract name
  const [wrapperContractName, setWrapperContractName] = useState<string | null>(
    config.yieldSource.contractName || null
  );

  useEffect(() => {
    if (config.yieldSource.address && !wrapperContractName && config.yieldSource.address !== "0x0000000000000000000000000000000000000000") {
      fetch(`/api/explorer?action=getName&address=${config.yieldSource.address}&chainId=1`)
        .then((res) => res.json() as Promise<{ result?: string }>)
        .then((data) => {
          if (data.result) {
            setWrapperContractName(data.result);
          }
        })
        .catch(() => {
          // Silently fail - name is optional
        });
    }
  }, [config.yieldSource.address, wrapperContractName]);

  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    let yPos = 0;
    const xCenter = 320;
    const xLeft = 20;
    const ySpacing = 220;

    // 1. User node
    nodes.push({
      id: "user",
      type: "user",
      position: { x: xLeft, y: yPos + 40 },
      data: {
        title: "USER",
        color: "accent",
        items: [
          `deposit(${assetSymbol})`,
          `mint(shares)`,
          "---",
          `withdraw(${assetSymbol})`,
          `redeem(shares)`,
        ],
      },
    });

    // Get vault logo by strategy address
    const vaultConfig = getVaultByAddress(config.address);
    const strategyLogo = vaultConfig?.logo;

    // Get yield source logo based on name
    const wrapperLogo = getYieldSourceLogo(yieldSourceName, wrapperContractName);

    // Determine claim function
    const claimFn = config.yieldSource.claimFn || "getReward";

    // 2. Strategy node (combined with wrapper/yield source info)
    // Use combined node for all strategies that have rewards or auctions
    if (!isPassThrough || hasAuction || rewardTokens.length > 0) {
      // Combined strategy + yield source node
      nodes.push({
        id: "strategy",
        type: "combinedStrategy",
        position: { x: xCenter, y: yPos },
        data: {
          title: config.name || "Strategy",
          subtitle: "ERC-4626 Tokenized Strategy",
          address: config.address,
          color: "accent",
          icon: <Database className="h-4 w-4" />,
          strategyLogo,
          strategyFunction: "report()",
          // Nested wrapper/yield source data
          wrapperTitle: isPassThrough
            ? "Pirex CVX (Votium Snapshots)"
            : wrapperContractName
              ? `${yieldSourceName} (${wrapperContractName})`
              : yieldSourceName,
          wrapperAddress: config.yieldSource.address,
          wrapperDepositFn: isPassThrough ? undefined : `${config.yieldSource.depositFn || "stake"}()`,
          wrapperWithdrawFn: isPassThrough ? undefined : `${config.yieldSource.withdrawFn || "unstake"}()`,
          wrapperFunction: `${claimFn}()`,
          wrapperLogo: isPassThrough ? "/tokens/pxcvx.png" : wrapperLogo,
          rewardTokens,
          assetSymbol,
          isDirectCompounding: isDirect, // Only show purple compound line for direct compounding (reward = asset)
          isPassThrough, // Pass through for styling differences
        },
      });

      yPos += ySpacing + 100; // Account for taller combined node with function and rewards
    } else {
      // Simple strategy node without wrapper (truly simple strategies)
      nodes.push({
        id: "strategy",
        type: "strategy",
        position: { x: xCenter, y: yPos },
        data: {
          title: config.name || "Strategy",
          subtitle: "ERC-4626 Tokenized Strategy",
          address: config.address,
          description: `Asset: ${assetSymbol}`,
          color: "accent",
          icon: <Database className="h-4 w-4" />,
          items: ["report()", "deposit()", "withdraw()"],
        },
      });

      yPos += ySpacing;
    }

    // Strategy node ID is always "strategy" now
    const strategyNodeId = "strategy";

    // Share token symbol (e.g., yscvxCRV)
    const shareSymbol = `ys${assetSymbol}`;

    // Edge: User -> Strategy (deposit/mint)
    edges.push({
      id: "e-user-deposit",
      source: "user",
      target: strategyNodeId,
      sourceHandle: "right",
      targetHandle: "left",
      type: "multiLineLabelSmoothStep",
      data: { lines: [`${assetSymbol} →`, `← ${shareSymbol}`] },
      ...createEdgeStyle("#22c55e"),
    });

    // Edge: Strategy -> User (withdraw/redeem)
    edges.push({
      id: "e-strategy-withdraw",
      source: strategyNodeId,
      target: "user",
      sourceHandle: "left-mid",
      targetHandle: "right-bottom",
      type: "multiLineLabelSmoothStep",
      data: { lines: [`${shareSymbol} →`, `← ${assetSymbol}`] },
      ...createEdgeStyle("#f59e0b"),
    });

    yPos += ySpacing - 80;

    // 5. Keeper (positioned to the right of the strategy)
    const keeperIsPermissionless = config.keeper?.isPermissionless ?? false;
    const keeperAddress = config.keeper?.address ?? null;
    const xRight = xCenter + 350;
    nodes.push({
      id: "keeper",
      type: "keeper",
      position: { x: xRight, y: 20 },
      data: {
        title: "KEEPER",
        subtitle: keeperIsPermissionless ? "(permissionless)" : "(permissioned)",
        address: keeperAddress || undefined,
        color: "cyan",
        isPermissionless: keeperIsPermissionless,
      },
    });

    // Keeper calls report() on the strategy, which triggers the harvest cycle
    edges.push({
      id: "e-keeper-strategy",
      source: "keeper",
      target: strategyNodeId,
      sourceHandle: "left",
      targetHandle: "right-report",
      ...createEdgeStyle("#06b6d4"),
    });

    // 6. Auction (if applicable)
    if (hasAuction && config.compounding.auction) {
      const auctionAddress = config.compounding.auction.address;

      // KICK node - anyone can call kick() to start auction
      nodes.push({
        id: "kick",
        type: "keeper",
        position: { x: xLeft, y: yPos + 80 },
        data: {
          title: "KICK",
          subtitle: "(permissionless)",
          color: "green",
          isPermissionless: true,
        },
      });

      // Use reward tokens array for auction visualization
      const rewardTokensArray = config.rewards.tokens.length > 0
        ? config.rewards.tokens
        : ["REWARDS"]; // Fallback when tokens not parsed

      nodes.push({
        id: "auction",
        type: "auction",
        position: { x: xCenter, y: yPos + 120 },
        data: {
          title: "Dutch Auction",
          subtitle: "Price decays until taker buys",
          address: auctionAddress || undefined,
          description: `Auctions sell rewards for ${assetSymbol}`,
          color: "accent",
          rewardTokens: rewardTokensArray,
          targetAsset: assetSymbol,
        },
      });

      // Edge: KICK -> Strategy (calls kickAuction() on strategy)
      edges.push({
        id: "e-kick-strategy",
        source: "kick",
        target: strategyNodeId,
        sourceHandle: "right",
        targetHandle: "left-bottom",
        label: `kickAuction()`,
        ...createEdgeStyle("#22c55e"),
      });

      // Edge: Strategy -> Auction (kickAuction transfers rewards and calls kick())
      edges.push({
        id: "e-strategy-auction",
        source: strategyNodeId,
        target: "auction",
        sourceHandle: "bottom",
        targetHandle: "top",
        label: `kick()`,
        ...createEdgeStyle("#22c55e"),
      });

      // Taker node (positioned lower to account for taller auction node)
      nodes.push({
        id: "taker",
        type: "keeper",
        position: { x: xLeft, y: yPos + 220 },
        data: {
          title: "TAKER",
          subtitle: "(permissionless)",
          color: "accent",
          isPermissionless: true,
        },
      });

      // Edge: Taker -> Auction (take rewards, pay with asset)
      edges.push({
        id: "e-taker-auction",
        source: "taker",
        target: "auction",
        sourceHandle: "right",
        targetHandle: "left",
        label: `take()`,
        ...createEdgeStyle("#f59e0b"),
      });

      // Edge: Auction -> Taker (taker receives reward tokens)
      edges.push({
        id: "e-auction-taker",
        source: "auction",
        target: "taker",
        sourceHandle: "left",
        targetHandle: "right",
        label: `Receive ${rewardTokens}`,
        type: "smoothstep",
        ...createEdgeStyle("#52525b"),
      });

      // Compound edge: Auction -> Strategy (vault)
      // Purchased asset goes to the vault, which re-stakes on next deposit/report
      edges.push({
        id: "e-compound",
        source: "auction",
        target: strategyNodeId,
        sourceHandle: "right",
        targetHandle: "right",
        label: assetSymbol,
        type: "smoothstep",
        ...createEdgeStyle("#a855f7"),
      });

      yPos += ySpacing;
    } else {
      // No auction - rewards compound directly within strategy (no external flow needed)
    }

    return { initialNodes: nodes, initialEdges: edges };
  }, [config, assetSymbol, yieldSourceName, rewardTokens, hasAuction, isDirect, isPassThrough, wrapperContractName]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { zoomIn, zoomOut, setViewport } = useReactFlow();

  // Hover callbacks for user node deposit/withdraw sections
  const handleHoverDeposit = useCallback(
    (hovering: boolean) => {
      setEdges((eds) =>
        eds.map((edge) => {
          if (edge.id === "e-user-deposit") {
            return {
              ...edge,
              animated: hovering,
              style: { ...edge.style, strokeDasharray: hovering ? "5,5" : undefined },
            };
          }
          return edge;
        })
      );
      // Animate _deployFunds() and stake() in strategy node
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === "strategy") {
            return {
              ...n,
              data: { ...n.data, isDepositAnimating: hovering },
            };
          }
          return n;
        })
      );
    },
    [setEdges, setNodes]
  );

  const handleHoverWithdraw = useCallback(
    (hovering: boolean) => {
      setEdges((eds) =>
        eds.map((edge) => {
          if (edge.id === "e-strategy-withdraw") {
            return {
              ...edge,
              animated: hovering,
              style: { ...edge.style, strokeDasharray: hovering ? "5,5" : undefined },
            };
          }
          return edge;
        })
      );
      // Animate _freeFunds() and unstake() in strategy node
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === "strategy") {
            return {
              ...n,
              data: { ...n.data, isWithdrawAnimating: hovering },
            };
          }
          return n;
        })
      );
    },
    [setEdges, setNodes]
  );

  // Update nodes/edges when config changes, and add hover callbacks to user node
  useEffect(() => {
    const updatedNodes = initialNodes.map((node) => {
      if (node.id === "user") {
        return {
          ...node,
          data: {
            ...node.data,
            onHoverDeposit: handleHoverDeposit,
            onHoverWithdraw: handleHoverWithdraw,
          },
        };
      }
      return node;
    });
    setNodes(updatedNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges, handleHoverDeposit, handleHoverWithdraw]);

  // Handle node hover for edge animation
  const onNodeMouseEnter = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.id === "keeper") {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id === "e-keeper-strategy") {
              return {
                ...edge,
                animated: true,
                style: { ...edge.style, strokeDasharray: "5,5" },
              };
            }
            return edge;
          })
        );
        // Animate internal lines in strategy node
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === "strategy") {
              return {
                ...n,
                data: { ...n.data, isAnimating: true },
              };
            }
            return n;
          })
        );
      } else if (node.id === "kick") {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id === "e-kick-strategy" || edge.id === "e-strategy-auction") {
              return {
                ...edge,
                animated: true,
                style: { ...edge.style, strokeDasharray: "5,5" },
              };
            }
            return edge;
          })
        );
        // Animate reward token buttons in auction and strategy nodes
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === "auction" || n.id === "strategy") {
              return {
                ...n,
                data: { ...n.data, isKickAnimating: true },
              };
            }
            return n;
          })
        );
      } else if (node.id === "taker") {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id === "e-taker-auction" || edge.id === "e-compound") {
              return {
                ...edge,
                animated: true,
                style: { ...edge.style, strokeDasharray: "5,5" },
              };
            }
            return edge;
          })
        );
        // Also animate the merging lines inside the auction node
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === "auction") {
              return {
                ...n,
                data: { ...n.data, isAnimating: true },
              };
            }
            return n;
          })
        );
      }
    },
    [setEdges, setNodes]
  );

  const onNodeMouseLeave = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.id === "keeper") {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id === "e-keeper-strategy") {
              return {
                ...edge,
                animated: false,
                style: { ...edge.style, strokeDasharray: undefined },
              };
            }
            return edge;
          })
        );
        // Stop animating internal lines in strategy node
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === "strategy") {
              return {
                ...n,
                data: { ...n.data, isAnimating: false },
              };
            }
            return n;
          })
        );
      } else if (node.id === "kick") {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id === "e-kick-strategy" || edge.id === "e-strategy-auction") {
              return {
                ...edge,
                animated: false,
                style: { ...edge.style, strokeDasharray: undefined },
              };
            }
            return edge;
          })
        );
        // Stop animating reward token buttons in auction and strategy nodes
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === "auction" || n.id === "strategy") {
              return {
                ...n,
                data: { ...n.data, isKickAnimating: false },
              };
            }
            return n;
          })
        );
      } else if (node.id === "taker") {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id === "e-taker-auction" || edge.id === "e-compound") {
              return {
                ...edge,
                animated: false,
                style: { ...edge.style, strokeDasharray: undefined },
              };
            }
            return edge;
          })
        );
        // Stop animating the merging lines inside the auction node
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === "auction") {
              return {
                ...n,
                data: { ...n.data, isAnimating: false },
              };
            }
            return n;
          })
        );
      }
    },
    [setEdges, setNodes]
  );

  return (
    <div
      className="h-[850px] w-full rounded-lg border overflow-hidden"
      style={{
        background: "var(--background)",
        borderColor: "var(--border)",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeMouseEnter={onNodeMouseEnter}
        edgeTypes={edgeTypes}
        onNodeMouseLeave={onNodeMouseLeave}
        nodeTypes={nodeTypes}
        defaultViewport={{ x: 50, y: 20, zoom: 0.85 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={true}
        nodesConnectable={false}
        panOnDrag={true}
        zoomOnScroll={true}
        minZoom={0.3}
        maxZoom={2}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
        connectionLineType={ConnectionLineType.SmoothStep}
      >
        <Background color="#27272a" gap={20} />
        <Panel position="top-right" className="m-2">
          <div className="flex flex-row bg-[#18181b] border border-[#27272a] rounded-lg overflow-hidden">
            <button
              onClick={() => zoomIn()}
              className="p-2 hover:bg-[#27272a] text-[#a1a1aa] border-r border-[#27272a]"
              title="Zoom In"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={() => zoomOut()}
              className="p-2 hover:bg-[#27272a] text-[#a1a1aa] border-r border-[#27272a]"
              title="Zoom Out"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={() => setViewport({ x: 50, y: 20, zoom: 0.85 })}
              className="p-2 hover:bg-[#27272a] text-[#a1a1aa]"
              title="Reset View"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            </button>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export function StrategyFlowDiagram({ config }: StrategyFlowDiagramProps) {
  return (
    <ReactFlowProvider>
      <StrategyFlowDiagramInner config={config} />
    </ReactFlowProvider>
  );
}
