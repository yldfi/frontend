/**
 * VNet Simulation — calls tenderly_simulateTransaction via the connected VNet RPC.
 *
 * The RPC method is available on Tenderly Virtual TestNet endpoints and returns
 * camelCase fields with hex-encoded amounts, unlike the REST API which uses
 * snake_case with decimal strings.
 *
 * Docs: https://docs.tenderly.co/virtual-testnets/interact/simulate-transactions
 */

import type { SimulationResult, SimulationAssetChange } from "@/types/enso";
import { CURVE_CONTROLLERS, getVaultByAddress } from "@/config/vaults";
import { CRVUSD_ADDRESS } from "@/config/addresses";

// Build sets of known addresses for asset change classification
const CURVE_CONTROLLER_ADDRESSES = new Set(
  Object.values(CURVE_CONTROLLERS).map((a) => a.toLowerCase())
);

// --- RPC response types (camelCase, hex amounts) ---

interface VNetAssetInfo {
  standard: string;       // "ERC20", "ERC721"
  type: string;           // "Fungible", "Non Fungible"
  contractAddress: string;
  symbol: string;
  name: string;
  logo?: string;
  decimals: number;
  dollarValue?: string;
}

interface VNetAssetChange {
  assetInfo: VNetAssetInfo;
  type: string;           // "Transfer", "Mint", "Burn"
  from: string;
  to: string;
  rawAmount: string;      // hex e.g. "0x1"
  amount: string;         // human readable e.g. "0.000000000000000001"
  dollarValue?: string;
}

interface VNetSimulationResponse {
  trace?: unknown;
  logs?: unknown;
  assetChanges?: VNetAssetChange[];
  balanceChanges?: unknown;
  status?: boolean;
  gasUsed?: string;       // hex
}

// --- Public API ---

/**
 * Run a simulation via the Tenderly VNet RPC endpoint.
 *
 * Falls back gracefully if the RPC method is unavailable (returns null result).
 */
export async function runVNetSimulation(
  transport: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> },
  params: {
    from: string;
    to: string;
    data: string;
    value?: string;
    gas?: string;
  },
  userAddress: string,
): Promise<{ ok: boolean; result: SimulationResult | null; errorMessage?: string }> {
  try {
    const response = await transport.request({
      method: "tenderly_simulateTransaction",
      params: [
        {
          from: params.from,
          to: params.to,
          data: params.data,
          value: params.value ?? "0x0",
          gas: params.gas ?? "0x0",
          gasPrice: "0x0",
        },
        "latest",
      ],
    }) as VNetSimulationResponse;

    if (process.env.NODE_ENV === "development") {
      console.log("[VNet Simulation] raw response keys:", Object.keys(response ?? {}));
      console.log("[VNet Simulation] assetChanges:", JSON.stringify(response?.assetChanges?.slice(0, 3), null, 2));
    }

    // Check for explicit failure status (if present)
    // The RPC method may not return a status field — absence means success
    if (response?.status === false) {
      return {
        ok: false,
        result: {
          success: false,
          gasUsed: response.gasUsed ? parseInt(response.gasUsed, 16) : null,
          errorMessage: "Transaction would revert",
          simulationId: null,
          tenderlyUrl: null,
          assetChanges: [],
        },
        errorMessage: "Transaction would revert",
      };
    }

    const gasUsed = response?.gasUsed ? parseInt(response.gasUsed, 16) : null;
    const assetChanges = processVNetAssetChanges(response?.assetChanges, userAddress);

    const result: SimulationResult = {
      success: true,
      gasUsed,
      errorMessage: null,
      simulationId: null,   // RPC simulations are ephemeral — no ID
      tenderlyUrl: null,     // No dashboard link for RPC sims
      assetChanges,
    };

    return { ok: true, result };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    const msg = error?.message ?? "VNet simulation failed";

    // -32601 = method not found → VNet doesn't support simulation, graceful fallback
    if (error?.code === -32601) {
      if (process.env.NODE_ENV === "development") {
        console.log("[VNet Simulation] tenderly_simulateTransaction not available, skipping");
      }
      return { ok: false, result: null, errorMessage: "VNet simulation not available" };
    }

    if (process.env.NODE_ENV === "development") {
      console.log("[VNet Simulation] error:", msg);
    }

    return { ok: false, result: null, errorMessage: msg };
  }
}

// --- Asset change processing ---

function processVNetAssetChanges(
  assetChanges: VNetAssetChange[] | undefined,
  userAddress: string,
): SimulationAssetChange[] {
  if (!assetChanges || !Array.isArray(assetChanges)) return [];

  const normalizedUser = userAddress.toLowerCase();
  const result: SimulationAssetChange[] = [];

  for (const change of assetChanges) {
    const from = change.from?.toLowerCase() ?? "";
    const to = change.to?.toLowerCase() ?? "";
    const tokenAddress = change.assetInfo?.contractAddress?.toLowerCase() ?? "";
    const isCrvUsd = tokenAddress === CRVUSD_ADDRESS.toLowerCase();

    const isUserSending = from === normalizedUser;
    const isUserReceiving = to === normalizedUser;
    const isToController = CURVE_CONTROLLER_ADDRESSES.has(to);
    const isFromController = CURVE_CONTROLLER_ADDRESSES.has(from);

    // Convert hex rawAmount to decimal string
    const rawAmount = hexToDecimal(change.rawAmount);

    const baseChange = {
      symbol: change.assetInfo?.symbol ?? "???",
      amount: change.amount ?? "0",
      rawAmount,
      address: change.assetInfo?.contractAddress ?? "",
      decimals: change.assetInfo?.decimals ?? 18,
      logo: change.assetInfo?.logo,
      dollarValue: change.dollarValue ?? change.assetInfo?.dollarValue,
    };

    // crvUSD to controller = repay
    if (isCrvUsd && isToController && !isFromController) {
      result.push({ ...baseChange, type: "repay" });
      continue;
    }

    // crvUSD from controller = borrow
    if (isCrvUsd && isFromController && isUserReceiving) {
      result.push({ ...baseChange, type: "borrow" });
      continue;
    }

    // Vault collateral token → detected via getVaultByAddress
    const isVaultCollateral = getVaultByAddress(tokenAddress) !== undefined;

    // Collateral going into a non-user address (AMM/controller) = deposit
    if (isVaultCollateral && isUserSending && !isUserReceiving) {
      result.push({ ...baseChange, type: "deposit" });
      continue;
    }

    // Collateral coming to user from a non-user address = receive (withdraw)
    if (isVaultCollateral && isUserReceiving && !isUserSending) {
      result.push({ ...baseChange, type: "receive" });
      continue;
    }

    // Regular user send/receive
    if (!isUserSending && !isUserReceiving) continue;

    result.push({
      ...baseChange,
      type: isUserSending ? "send" : "receive",
    });
  }

  return result;
}

/** Convert hex string (e.g. "0x1") to decimal string (e.g. "1") */
function hexToDecimal(hex: string): string {
  if (!hex) return "0";
  try {
    return BigInt(hex).toString();
  } catch {
    return hex; // Already decimal or unparseable — return as-is
  }
}
