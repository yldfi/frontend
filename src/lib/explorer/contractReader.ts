import {
  createPublicClient,
  http,
  getAddress,
  formatUnits,
  type PublicClient,
  type Abi,
} from "viem";
import { mainnet } from "viem/chains";
import type { ABIItem, ContractValue } from "@/types/explorer";
import { getContractABI, isValidAddress, isZeroAddress } from "./etherscan";

// Use PublicNode free RPC
const RPC_URL = "https://ethereum-rpc.publicnode.com";

let client: PublicClient | null = null;

function getClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: mainnet,
      transport: http(RPC_URL),
    });
  }
  return client;
}

// In-memory caches for the session
const valuesCache = new Map<
  string,
  { values: ContractValue[]; abi: ABIItem[]; implementationAddress?: string }
>();
const proxyImplCache = new Map<string, string | null>();
const isContractCache = new Map<string, boolean>();

// EIP-1967 storage slots for proxy detection
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as `0x${string}`;
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as `0x${string}`;

// Try to get implementation address from proxy
export async function getProxyImplementation(proxyAddress: string): Promise<string | null> {
  const normalizedAddress = proxyAddress.toLowerCase();

  // Check in-memory cache first
  if (proxyImplCache.has(normalizedAddress)) {
    return proxyImplCache.get(normalizedAddress)!;
  }

  const publicClient = getClient();

  try {
    // First, check for ERC-1167 Minimal Proxy (clone) by reading bytecode
    const bytecode = await publicClient.getCode({ address: proxyAddress as `0x${string}` });

    if (bytecode && bytecode.length >= 90) {
      // Check for ERC-1167 prefix pattern (accounting for 0x prefix)
      const prefix = bytecode.slice(0, 22).toLowerCase();
      if (prefix === "0x363d3d373d3d3d363d73") {
        const implAddress = ("0x" + bytecode.slice(22, 62)) as `0x${string}`;
        if (await isContract(implAddress)) {
          const result = getAddress(implAddress);
          proxyImplCache.set(normalizedAddress, result);
          return result;
        }
      }

      // Alternative: check for suffix pattern and extract address
      if (bytecode.toLowerCase().includes("5af43d82803e903d91602b57fd5bf3")) {
        const lowerBytecode = bytecode.toLowerCase();
        const push20Index = lowerBytecode.indexOf("363d3d373d3d3d363d73");
        if (push20Index !== -1) {
          const addrStart = push20Index + 20;
          const implAddress = ("0x" + bytecode.slice(addrStart + 2, addrStart + 42)) as `0x${string}`;
          if (implAddress.length === 42 && (await isContract(implAddress))) {
            const result = getAddress(implAddress);
            proxyImplCache.set(normalizedAddress, result);
            return result;
          }
        }
      }
    }

    // Try EIP-1967 implementation slot
    const implSlot = await publicClient.getStorageAt({
      address: proxyAddress as `0x${string}`,
      slot: IMPLEMENTATION_SLOT,
    });
    if (implSlot) {
      const implAddress = ("0x" + implSlot.slice(-40)) as `0x${string}`;
      if (implAddress !== "0x0000000000000000000000000000000000000000" && (await isContract(implAddress))) {
        const result = getAddress(implAddress);
        proxyImplCache.set(normalizedAddress, result);
        return result;
      }
    }

    // Try beacon slot
    const beaconSlot = await publicClient.getStorageAt({
      address: proxyAddress as `0x${string}`,
      slot: BEACON_SLOT,
    });
    if (beaconSlot) {
      const beaconAddress = ("0x" + beaconSlot.slice(-40)) as `0x${string}`;
      if (beaconAddress !== "0x0000000000000000000000000000000000000000" && (await isContract(beaconAddress))) {
        // Get implementation from beacon
        try {
          const beaconImpl = await publicClient.readContract({
            address: beaconAddress,
            abi: [
              {
                inputs: [],
                name: "implementation",
                outputs: [{ type: "address" }],
                stateMutability: "view",
                type: "function",
              },
            ] as const,
            functionName: "implementation",
          });
          if (beaconImpl && beaconImpl !== "0x0000000000000000000000000000000000000000") {
            proxyImplCache.set(normalizedAddress, beaconImpl);
            return beaconImpl;
          }
        } catch {
          // Beacon doesn't have implementation function
        }
      }
    }

    // Try calling implementation() directly on the proxy
    try {
      const impl = await publicClient.readContract({
        address: proxyAddress as `0x${string}`,
        abi: [
          {
            inputs: [],
            name: "implementation",
            outputs: [{ type: "address" }],
            stateMutability: "view",
            type: "function",
          },
        ] as const,
        functionName: "implementation",
      });
      if (impl && impl !== "0x0000000000000000000000000000000000000000") {
        proxyImplCache.set(normalizedAddress, impl);
        return impl;
      }
    } catch {
      // No implementation function
    }

    proxyImplCache.set(normalizedAddress, null);
    return null;
  } catch {
    proxyImplCache.set(normalizedAddress, null);
    return null;
  }
}

// Check if address is a contract (has code) vs EOA
export async function isContract(address: string): Promise<boolean> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  if (isContractCache.has(normalizedAddress)) {
    return isContractCache.get(normalizedAddress)!;
  }

  const publicClient = getClient();
  const code = await publicClient.getCode({ address: address as `0x${string}` });
  const result = code !== undefined && code !== "0x" && code !== "0x0";
  isContractCache.set(normalizedAddress, result);
  return result;
}

export function getViewFunctions(abi: ABIItem[]): ABIItem[] {
  return abi.filter(
    (item) =>
      item.type === "function" &&
      (item.stateMutability === "view" || item.stateMutability === "pure") &&
      item.inputs?.length === 0
  );
}

// Gnosis Safe ABI for detection
const GNOSIS_SAFE_ABI = [
  {
    inputs: [],
    name: "getOwners",
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getThreshold",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "VERSION",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface GnosisSafeInfo {
  owners: string[];
  threshold: number;
  version?: string;
}

// In-memory cache for Safe info
const safeInfoCache = new Map<string, GnosisSafeInfo | null>();

// Check if address is a Gnosis Safe and get its info
export async function getGnosisSafeInfo(address: string): Promise<GnosisSafeInfo | null> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  if (safeInfoCache.has(normalizedAddress)) {
    return safeInfoCache.get(normalizedAddress)!;
  }

  const publicClient = getClient();

  try {
    // Try to call getOwners and getThreshold - if both work, it's a Safe
    const [owners, threshold] = await Promise.all([
      publicClient.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: "getOwners",
      }),
      publicClient.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: "getThreshold",
      }),
    ]);

    // Try to get version (optional)
    let version: string | undefined;
    try {
      version = await publicClient.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: "VERSION",
      });
    } catch {
      // Version not available
    }

    const info: GnosisSafeInfo = {
      owners: owners as string[],
      threshold: Number(threshold),
      version,
    };

    safeInfoCache.set(normalizedAddress, info);
    return info;
  } catch {
    // Not a Gnosis Safe
    safeInfoCache.set(normalizedAddress, null);
    return null;
  }
}

export async function readContractValue(
  address: string,
  abi: ABIItem[],
  functionName: string
): Promise<{ value: unknown; type: string }> {
  const publicClient = getClient();

  const func = abi.find((f) => f.name === functionName);
  if (!func || !func.outputs || func.outputs.length === 0) {
    throw new Error(`Function ${functionName} not found or has no outputs`);
  }

  const result = await publicClient.readContract({
    address: address as `0x${string}`,
    abi: abi as Abi,
    functionName: functionName,
  });

  const outputType = func.outputs[0].type;

  return { value: result, type: outputType };
}

// Small delay between calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readAllViewValues(
  address: string,
  abi?: ABIItem[]
): Promise<{ values: ContractValue[]; abi: ABIItem[]; implementationAddress?: string }> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  if (valuesCache.has(normalizedAddress)) {
    return valuesCache.get(normalizedAddress)!;
  }

  let implementationAddress: string | undefined;

  // Check if this is a proxy contract
  const proxyImpl = await getProxyImplementation(address);

  if (!abi) {
    abi = await getContractABI(address);
  }

  // If it's a proxy, try to get implementation ABI and merge
  if (proxyImpl) {
    implementationAddress = proxyImpl;
    try {
      const implAbi = await getContractABI(proxyImpl);
      // Merge ABIs - implementation ABI takes priority, but keep proxy-specific functions
      const implFuncNames = new Set(implAbi.filter((i) => i.type === "function").map((i) => i.name));
      const proxyOnlyFuncs = abi.filter((i) => i.type === "function" && !implFuncNames.has(i.name));
      abi = [...implAbi, ...proxyOnlyFuncs];
    } catch {
      // Couldn't get implementation ABI, use proxy ABI
    }
  }

  const viewFunctions = getViewFunctions(abi);
  const values: ContractValue[] = [];

  // Process sequentially to avoid rate limiting
  for (const func of viewFunctions) {
    try {
      const { value, type } = await readContractValue(address, abi!, func.name!);
      values.push({
        name: func.name!,
        value,
        type,
        isAddress: type === "address" || (type === "address[]" && Array.isArray(value)),
        error: undefined,
      });
    } catch (error) {
      values.push({
        name: func.name!,
        value: null,
        type: func.outputs?.[0]?.type || "unknown",
        isAddress: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    // Small delay between calls
    await delay(50);
  }

  const result = { values, abi, implementationAddress };
  valuesCache.set(normalizedAddress, result);
  return result;
}

export function extractAddresses(values: ContractValue[]): { address: string; sourceName: string }[] {
  const addresses: { address: string; sourceName: string }[] = [];

  for (const val of values) {
    if (val.isAddress && val.value) {
      if (Array.isArray(val.value)) {
        for (const addr of val.value) {
          if (isValidAddress(addr) && !isZeroAddress(addr)) {
            addresses.push({ address: addr, sourceName: val.name });
          }
        }
      } else if (isValidAddress(val.value) && !isZeroAddress(val.value as string)) {
        addresses.push({ address: val.value as string, sourceName: val.name });
      }
    }
  }

  return addresses;
}

// Max uint256 value (2^256 - 1)
const MAX_UINT256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

// Common duration values in seconds
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;
const YEAR = 31536000;

// Format seconds as human-readable duration
function formatDuration(seconds: number): string | null {
  if (seconds < MINUTE || seconds > YEAR) return null;

  if (seconds >= DAY) {
    const days = Math.floor(seconds / DAY);
    const remainingHours = Math.floor((seconds % DAY) / HOUR);

    if (seconds % WEEK === 0) {
      const weeks = seconds / WEEK;
      return weeks === 1 ? "1 week" : `${weeks} weeks`;
    }
    if (remainingHours > 0) {
      return `${days}d ${remainingHours}h`;
    }
    return days === 1 ? "1 day" : `${days} days`;
  }

  if (seconds >= HOUR) {
    const hours = Math.floor(seconds / HOUR);
    const remainingMinutes = Math.floor((seconds % HOUR) / MINUTE);
    if (remainingMinutes > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }

  if (seconds >= MINUTE) {
    const minutes = Math.floor(seconds / MINUTE);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }

  return null;
}

function isBasisPointsField(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    lowerName.includes("fee") ||
    lowerName.includes("bps") ||
    lowerName.includes("basis") ||
    lowerName.includes("weight") ||
    (lowerName.includes("rate") && !lowerName.includes("unlock"))
  );
}

function isDurationField(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    lowerName.includes("time") ||
    lowerName.includes("period") ||
    lowerName.includes("duration") ||
    lowerName.includes("delay") ||
    lowerName.includes("interval") ||
    lowerName.includes("timeout") ||
    lowerName.includes("cooldown")
  );
}

function formatBasisPoints(value: number): string {
  const percentage = value / 100;
  if (percentage % 1 === 0) {
    return `${percentage}%`;
  }
  return `${percentage.toFixed(2)}%`;
}

export function formatValue(value: unknown, type: string, name?: string): string {
  if (value === null || value === undefined) return "null";

  // Handle BigInt
  if (typeof value === "bigint") {
    if (value === MAX_UINT256 || value >= MAX_UINT256 - 1000n) {
      return "Unlimited";
    }

    const num = Number(value);
    if (name && isBasisPointsField(name) && num <= 10000) {
      return formatBasisPoints(num);
    }

    if (type.includes("uint256") || type.includes("int256")) {
      const num = Number(value);
      if (num > 1577836800 && num < 1893456000) {
        return new Date(num * 1000).toLocaleString();
      }
      if (name && isDurationField(name)) {
        const duration = formatDuration(num);
        if (duration) {
          return duration;
        }
      }
      if (value > 10n ** 15n) {
        const formatted = formatUnits(value, 18);
        const num = parseFloat(formatted);
        if (num >= 1000000) {
          return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
        } else if (num >= 1) {
          return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
        } else {
          return num.toLocaleString(undefined, { maximumSignificantDigits: 6 });
        }
      }
      return value.toLocaleString();
    }
    return value.toString();
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((v) => formatValue(v, type.replace("[]", ""))).join(", ");
  }

  // Handle tuples/structs
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([key]) => isNaN(Number(key)))
      .map(([key, val]) => `${key}: ${formatValue(val, "unknown", key)}`);
    return `{ ${entries.join(", ")} }`;
  }

  // Handle booleans
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  // Handle strings
  if (typeof value === "string") {
    return value;
  }

  // Handle numbers (uint8, uint16, etc. may come as Number instead of BigInt)
  if (typeof value === "number") {
    if (name && isBasisPointsField(name) && value <= 10000) {
      return formatBasisPoints(value);
    }
    if (name && isDurationField(name)) {
      const duration = formatDuration(value);
      if (duration) {
        return duration;
      }
    }
    // Check if it looks like a timestamp
    if (value > 1577836800 && value < 1893456000) {
      return new Date(value * 1000).toLocaleString();
    }
    return value.toLocaleString();
  }

  return String(value);
}
