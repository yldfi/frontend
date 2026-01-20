"use client";

import { StrategyFlowConfig } from "@/lib/strategy-flow/types";

interface StaticStrategyFlowDiagramProps {
  config: StrategyFlowConfig;
}

function etherscanLink(address: string): string {
  return `https://etherscan.io/address/${address}`;
}

function AddressLink({ label, address }: { label: string; address: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--muted-foreground)]">{label}:</span>
      <a
        href={etherscanLink(address)}
        target="_blank"
        rel="noopener noreferrer"
        className="mono text-[var(--accent)] hover:underline"
      >
        {address}
      </a>
    </div>
  );
}

/**
 * Generates a comprehensive static ASCII diagram showing the full strategy lifecycle
 */
export function StaticStrategyFlowDiagram({ config }: StaticStrategyFlowDiagramProps) {
  const diagram = generateDiagram(config);
  const hasAuction = config.compounding.mechanism === "auction" && config.compounding.auction?.address;

  return (
    <div className="space-y-4">
      <pre className="mono text-[11px] text-[var(--muted-foreground)] whitespace-pre overflow-x-auto p-4 bg-[var(--muted)] rounded-lg border border-[var(--border)]" style={{ lineHeight: '1.2' }}>
        {diagram}
      </pre>

      {/* Contract addresses with Etherscan links */}
      <div className="text-xs space-y-1 p-3 bg-[var(--muted)] rounded-lg border border-[var(--border)]">
        <div className="text-[var(--foreground)] font-medium mb-2">Contract Addresses</div>
        <AddressLink label="Strategy" address={config.address} />
        {config.yieldSource.address && config.yieldSource.address !== "0x0000000000000000000000000000000000000000" && (
          <AddressLink label={config.yieldSource.name || "Yield Source"} address={config.yieldSource.address} />
        )}
        {hasAuction && config.compounding.auction?.address && (
          <AddressLink label="Auction" address={config.compounding.auction.address} />
        )}
        {config.asset.address && (
          <AddressLink label={`Asset (${config.asset.symbol})`} address={config.asset.address} />
        )}
      </div>
    </div>
  );
}

function generateDiagram(config: StrategyFlowConfig): string {
  const hasAuction = config.compounding.mechanism === "auction";
  const isDirect = config.compounding.mechanism === "direct";
  const isPassThrough = config.yieldSource.depositFn === "hold";

  const assetSymbol = config.asset.symbol || "ASSET";
  const vaultName = `ys${assetSymbol}`;
  const yieldSourceName = config.yieldSource.name || "YIELD SOURCE";
  const rewardTokens = config.rewards.tokens.length > 0
    ? config.rewards.tokens.join(" + ")
    : "REWARDS";

  const lines: string[] = [];
  const RIGHT_BOX_W = 57;
  const LEFT_BOX_W = 17;
  const ARROW_W = 16;
  // LEFT_PAD must equal LEFT_BOX_W + ARROW_W so centered boxes align with side-by-side right boxes
  const LEFT_PAD = LEFT_BOX_W + ARROW_W;

  // Title
  lines.push(...indentBox(boxLines(`STRATEGY LIFECYCLE - ${vaultName}`, RIGHT_BOX_W, 1), LEFT_PAD));
  lines.push("");

  // User interaction section - deposit & withdraw
  const userBox = boxLines("USER", LEFT_BOX_W, 13);
  const stratBox = boxLines([
    "TOKENIZED STRATEGY",
    `(${vaultName})`,
    truncAddr(config.address),
    "",
    "ERC-4626 vault"
  ], RIGHT_BOX_W, 13);

  for (let i = 0; i < userBox.length; i++) {
    let line = userBox[i];
    if (i === 2) {
      line += centerIn(`deposit(${assetSymbol})`, ARROW_W);
    } else if (i === 3) {
      line += " " + "-".repeat(ARROW_W - 3) + "> ";
    } else if (i === 4) {
      line += "<" + "-".repeat(ARROW_W - 3) + "  ";
    } else if (i === 5) {
      line += centerIn(`${vaultName} shares`, ARROW_W);
    } else if (i === 8) {
      line += centerIn(`redeem(shares)`, ARROW_W);
    } else if (i === 9) {
      line += " " + "-".repeat(ARROW_W - 3) + "> ";
    } else if (i === 10) {
      line += "<" + "-".repeat(ARROW_W - 3) + "  ";
    } else if (i === 11) {
      line += centerIn(assetSymbol, ARROW_W);
    } else {
      line += sp(ARROW_W);
    }
    line += stratBox[i];
    lines.push(line);
  }
  lines.push("");

  // Deploy funds
  if (!isPassThrough) {
    lines.push(sp(LEFT_PAD) + pipeWithLabel("", RIGHT_BOX_W));
    lines.push(sp(LEFT_PAD) + pipeWithLabel("2. DEPLOY FUNDS", RIGHT_BOX_W));
    lines.push(sp(LEFT_PAD) + centerIn("v", RIGHT_BOX_W));
    lines.push("");
    lines.push(...indentBox(boxLines([
      yieldSourceName.toUpperCase(),
      truncAddr(config.yieldSource.address),
      "",
      `${assetSymbol} ${config.yieldSource.depositFn === "stake" ? "staked" : "deposited"} here`,
      `earning ${rewardTokens}`
    ], RIGHT_BOX_W, 5), LEFT_PAD));
    lines.push("");
  }

  // Rewards accrual
  const rewardStep = isPassThrough ? "2" : "3";
  lines.push(sp(LEFT_PAD) + pipeWithLabel("", RIGHT_BOX_W));
  lines.push(sp(LEFT_PAD) + pipeWithLabel(`${rewardStep}. ACCRUE REWARDS`, RIGHT_BOX_W));
  lines.push(sp(LEFT_PAD) + centerIn("v", RIGHT_BOX_W));
  lines.push("");
  lines.push(...indentBox(boxLines(["REWARD TOKENS", rewardTokens], RIGHT_BOX_W, 2), LEFT_PAD));
  lines.push("");

  // Report
  const reportStep = isPassThrough ? "3" : "4";
  lines.push(sp(LEFT_PAD) + pipeWithLabel("", RIGHT_BOX_W));
  lines.push(sp(LEFT_PAD) + pipeWithLabel(`${reportStep}. KEEPER REPORTS`, RIGHT_BOX_W));
  lines.push(sp(LEFT_PAD) + centerIn("v", RIGHT_BOX_W));
  lines.push("");

  // Keeper box with arrow
  const keeperLines = boxLines(["KEEPER", "(permissionless)"], LEFT_BOX_W, 3);
  for (let i = 0; i < keeperLines.length; i++) {
    let line = keeperLines[i];
    if (i === 1) {
      line += centerIn("triggers", ARROW_W);
    } else if (i === 2) {
      line += " " + "-".repeat(ARROW_W - 3) + "> ";
    } else if (i === 3) {
      line += centerIn("report()", ARROW_W);
    } else {
      line += sp(ARROW_W);
    }
    lines.push(line);
  }
  lines.push("");

  // Auction flow
  if (hasAuction) {
    const auctionAddr = config.compounding.auction?.address;
    lines.push(...indentBox(boxLines([
      "DUTCH AUCTION",
      auctionAddr ? truncAddr(auctionAddr) : "",
      "",
      "rewards sent here",
      "price decays until taker buys"
    ], RIGHT_BOX_W, 5), LEFT_PAD));
    lines.push("");

    const takerStep = isPassThrough ? "4" : "5";
    lines.push(sp(LEFT_PAD) + pipeWithLabel("", RIGHT_BOX_W));
    lines.push(sp(LEFT_PAD) + pipeWithLabel(`${takerStep}. TAKER BIDS`, RIGHT_BOX_W));
    lines.push(sp(LEFT_PAD) + centerIn("v", RIGHT_BOX_W));
    lines.push("");

    lines.push(...sideBySide(
      boxLines(["TAKER", "(arbitrager)"], LEFT_BOX_W, 5),
      boxLines([
        "TOKEN SWAP",
        `Taker gets ${rewardTokens}`,
        "at discount",
        `Strategy gets ${assetSymbol}`
      ], RIGHT_BOX_W, 5),
      ARROW_W,
      { label: `sends ${assetSymbol}`, arrowLine: 2 }
    ));
    lines.push(sp(LEFT_BOX_W) + "<" + "-".repeat(ARROW_W - 2) + " " + sp(RIGHT_BOX_W));
    lines.push(sp(LEFT_BOX_W) + centerIn("gets rewards", ARROW_W) + sp(RIGHT_BOX_W));
    lines.push("");
  }

  // Compound step
  const compoundStep = hasAuction
    ? (isPassThrough ? "5" : "6")
    : (isPassThrough ? "4" : "5");

  lines.push(sp(LEFT_PAD) + pipeWithLabel("", RIGHT_BOX_W));
  lines.push(sp(LEFT_PAD) + pipeWithLabel(`${compoundStep}. COMPOUND`, RIGHT_BOX_W));
  lines.push(sp(LEFT_PAD) + centerIn("v", RIGHT_BOX_W));
  lines.push("");

  let compoundContent: string[];
  if (isDirect) {
    compoundContent = [
      "DIRECT COMPOUND",
      `${rewardTokens} = ${assetSymbol}`,
      "rewards are same as asset",
      "automatically re-staked"
    ];
  } else if (isPassThrough) {
    compoundContent = [
      `${assetSymbol} ADDED TO STRATEGY`,
      `new ${assetSymbol} increases balance`,
      "vault share price increases (APY)"
    ];
  } else {
    compoundContent = [
      `${assetSymbol} -> ${yieldSourceName.toUpperCase()}`,
      `new ${assetSymbol} staked`,
      "total assets increase",
      "vault share price increases (APY)"
    ];
  }
  lines.push(...indentBox(boxLines(compoundContent, RIGHT_BOX_W, compoundContent.length), LEFT_PAD));

  return lines.join("\n");
}

// Helper: create spaces
function sp(n: number): string {
  return " ".repeat(n);
}

// Helper: center text in width
function centerIn(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return sp(left) + text + sp(right);
}

// Helper: create vertical arrow line with | at center and optional label after
function pipeWithLabel(label: string, width: number): string {
  const center = Math.floor((width - 1) / 2);
  if (!label) {
    return sp(center) + "|" + sp(width - center - 1);
  }
  const content = "| " + label;
  const remaining = width - center - content.length;
  return sp(center) + content + sp(Math.max(0, remaining));
}

// Helper: create box lines array
function boxLines(content: string | string[], width: number, innerHeight: number): string[] {
  const contentArr = Array.isArray(content) ? content : [content];
  const inner = width - 4;

  const result: string[] = [];
  result.push("+" + "-".repeat(width - 2) + "+");

  const paddingTop = Math.floor((innerHeight - contentArr.length) / 2);
  const paddingBottom = innerHeight - contentArr.length - paddingTop;

  for (let i = 0; i < paddingTop; i++) {
    result.push("|" + sp(width - 2) + "|");
  }

  for (const line of contentArr) {
    const text = line.slice(0, inner);
    const centered = centerIn(text, inner);
    result.push("| " + centered + " |");
  }

  for (let i = 0; i < paddingBottom; i++) {
    result.push("|" + sp(width - 2) + "|");
  }

  result.push("+" + "-".repeat(width - 2) + "+");
  return result;
}

// Helper: indent box lines
function indentBox(box: string[], indent: number): string[] {
  return box.map(line => sp(indent) + line);
}

// Helper: side by side boxes with arrow
function sideBySide(
  leftBox: string[],
  rightBox: string[],
  arrowWidth: number,
  arrow: { label: string; subLabel?: string; arrowLine: number }
): string[] {
  const result: string[] = [];
  const maxLines = Math.max(leftBox.length, rightBox.length);

  for (let i = 0; i < maxLines; i++) {
    const left = leftBox[i] || sp(leftBox[0]?.length || 0);
    const right = rightBox[i] || sp(rightBox[0]?.length || 0);

    let middle: string;
    if (i === arrow.arrowLine - 1) {
      middle = centerIn(arrow.label, arrowWidth);
    } else if (i === arrow.arrowLine) {
      middle = " " + "-".repeat(arrowWidth - 3) + "> ";
    } else if (i === arrow.arrowLine + 1 && arrow.subLabel) {
      middle = centerIn(arrow.subLabel, arrowWidth);
    } else {
      middle = sp(arrowWidth);
    }

    result.push(left + middle + right);
  }

  return result;
}

function truncAddr(address: string): string {
  if (!address || address.length < 42) return address || "";
  return address.slice(0, 6) + "..." + address.slice(-4);
}
