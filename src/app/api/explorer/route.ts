import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Explorer API - Server-side Etherscan proxy with Cloudflare KV caching
 *
 * This keeps the Etherscan API key server-side and provides shared caching
 * across all users via Cloudflare KV.
 *
 * Usage:
 * - GET /api/explorer?action=getABI&address=0x...
 * - GET /api/explorer?action=getName&address=0x...
 * - GET /api/explorer?action=getNatSpec&address=0x...
 */

const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds (KV cache)
const BROWSER_CACHE_TTL = 60 * 60; // 1 hour in seconds (browser cache)
const CACHE_VERSION = "v2"; // Bump to invalidate old cached data

// Cache headers for successful responses
const cacheHeaders = {
  "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}, s-maxage=${BROWSER_CACHE_TTL}`,
};

// Etherscan API response types
interface EtherscanResponse {
  status: string;
  message: string;
  result: string | EtherscanSourceCode[];
}

interface EtherscanSourceCode {
  SourceCode: string;
  ContractName: string;
  CompilerVersion: string;
}

// Rate limiting for Etherscan API calls
let lastApiCall = 0;
const MIN_API_INTERVAL = 350;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCall;
  if (timeSinceLastCall < MIN_API_INTERVAL) {
    await new Promise((resolve) => setTimeout(resolve, MIN_API_INTERVAL - timeSinceLastCall));
  }
  lastApiCall = Date.now();
  return fetch(url);
}

import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(30);

// Get KV namespace from Cloudflare context
// Returns null in local dev if bindings aren't configured
function getKV(): KVNamespace | null {
  try {
    const ctx = getCloudflareContext();
    return (ctx.env as { EXPLORER_CACHE?: KVNamespace }).EXPLORER_CACHE || null;
  } catch {
    // Not running in Cloudflare environment (local dev without bindings)
    return null;
  }
}

export async function GET(request: NextRequest) {
  // Per-IP rate limiting
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get("action");
  const address = searchParams.get("address");
  const chainId = searchParams.get("chainId") || "1";

  if (!action || !address) {
    return NextResponse.json({ error: "Missing action or address parameter" }, { status: 400 });
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address format" }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase();
  const apiKey = process.env.ETHERSCAN_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "Etherscan API key not configured" }, { status: 500 });
  }

  const kv = getKV();

  try {
    switch (action) {
      case "getABI": {
        const cacheKey = `${CACHE_VERSION}_abi_${chainId}_${normalizedAddress}`;

        // Check KV cache first
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: JSON.parse(cached), cached: true }, { headers: cacheHeaders });
          }
        }

        // Fetch from Etherscan
        const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
        const response = await rateLimitedFetch(url);
        const data = (await response.json()) as EtherscanResponse;

        if (data.status !== "1") {
          return NextResponse.json(
            { error: (typeof data.result === "string" ? data.result : null) || data.message || "Failed to fetch ABI" },
            { status: 404 }
          );
        }

        const abi = JSON.parse(data.result as string);

        // Cache in KV
        if (kv) {
          await kv.put(cacheKey, JSON.stringify(abi), { expirationTtl: CACHE_TTL });
        }

        return NextResponse.json({ result: abi, cached: false }, { headers: cacheHeaders });
      }

      case "getName": {
        const cacheKey = `${CACHE_VERSION}_name_${chainId}_${normalizedAddress}`;

        // Check KV cache first
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: cached, cached: true }, { headers: cacheHeaders });
          }
        }

        // Fetch from Etherscan
        const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
        const response = await rateLimitedFetch(url);
        const data = (await response.json()) as EtherscanResponse;

        if (data.status !== "1" || !Array.isArray(data.result) || !data.result[0]) {
          return NextResponse.json({ result: null, cached: false }, { headers: cacheHeaders });
        }

        let name = data.result[0].ContractName || null;

        // If it's a proxy contract, try to get the implementation name
        if (name && isProxyContract(name)) {
          const implAddress = await getImplementationAddress(address, chainId, apiKey);
          if (implAddress) {
            const implName = await fetchContractName(implAddress, chainId, apiKey);
            if (implName && !isProxyContract(implName)) {
              name = implName;
            }
          }
        }

        // Cache in KV (only if we got a name)
        if (kv && name) {
          await kv.put(cacheKey, name, { expirationTtl: CACHE_TTL });
        }

        return NextResponse.json({ result: name, cached: false }, { headers: cacheHeaders });
      }

      case "getSource": {
        const cacheKey = `${CACHE_VERSION}_source_${chainId}_${normalizedAddress}`;

        // Check KV cache first (contract source never changes, cache indefinitely)
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: JSON.parse(cached), cached: true }, { headers: cacheHeaders });
          }
        }

        // Fetch from Etherscan
        const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
        const response = await rateLimitedFetch(url);
        const data = (await response.json()) as EtherscanResponse;

        if (data.status !== "1" || !Array.isArray(data.result) || !data.result[0]) {
          return NextResponse.json({ error: "Contract source not found or not verified" }, { status: 404 });
        }

        let sourceResult = data.result[0];
        let sourceAddress = address;
        let isProxy = false;

        // Check if this is a proxy contract - try to get implementation source
        const isLikelyProxy = !sourceResult.SourceCode || isProxyContract(sourceResult.ContractName);
        if (isLikelyProxy) {
          const implAddress = await getImplementationAddress(address, chainId, apiKey);
          if (implAddress) {
            // Fetch implementation source
            const implUrl = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${implAddress}&apikey=${apiKey}`;
            const implResponse = await rateLimitedFetch(implUrl);
            const implData = (await implResponse.json()) as EtherscanResponse;

            if (implData.status === "1" && Array.isArray(implData.result) && implData.result[0]?.SourceCode) {
              sourceResult = implData.result[0];
              sourceAddress = implAddress;
              isProxy = true;
            }
          }
        }

        if (!sourceResult.SourceCode) {
          return NextResponse.json({ error: "Contract source not found or not verified" }, { status: 404 });
        }

        let sourceCode = sourceResult.SourceCode;

        // Handle JSON-wrapped source (multi-file contracts from Etherscan)
        let files: Array<{ name: string; content: string }> = [];

        if (sourceCode.startsWith("{")) {
          try {
            // Double-wrapped JSON: {{...}}
            if (sourceCode.startsWith("{{")) {
              sourceCode = sourceCode.slice(1, -1);
            }
            const parsed = JSON.parse(sourceCode);
            const sources = parsed.sources || parsed;
            // Extract files with names
            files = Object.entries(sources).map(([name, source]: [string, unknown]) => ({
              name: name.split("/").pop() || name, // Get just the filename
              content: (source as { content?: string }).content || (source as string),
            }));
          } catch {
            // Not JSON, treat as single file
            files = [{ name: `${sourceResult.ContractName || "Contract"}.sol`, content: sourceCode }];
          }
        } else {
          // Single file source
          files = [{ name: `${sourceResult.ContractName || "Contract"}.sol`, content: sourceCode }];
        }

        // Sort files - main contract first
        const mainContractName = sourceResult.ContractName?.toLowerCase() || "";
        files.sort((a, b) => {
          if (a.name.toLowerCase().includes(mainContractName)) return -1;
          if (b.name.toLowerCase().includes(mainContractName)) return 1;
          return a.name.localeCompare(b.name);
        });

        const result = {
          files,
          name: sourceResult.ContractName || null,
          compiler: sourceResult.CompilerVersion || null,
          isProxy,
          implementationAddress: isProxy ? sourceAddress : null,
        };

        // Cache in KV (contract source never changes)
        if (kv) {
          await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL * 365 }); // Cache for a year
        }

        return NextResponse.json({ result, cached: false }, { headers: cacheHeaders });
      }

      case "getNatSpec": {
        const cacheKey = `${CACHE_VERSION}_natspec_${chainId}_${normalizedAddress}`;

        // Check KV cache first
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: JSON.parse(cached), cached: true }, { headers: cacheHeaders });
          }
        }

        // Fetch from Etherscan
        const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
        const response = await rateLimitedFetch(url);
        const data = (await response.json()) as EtherscanResponse;

        if (data.status !== "1" || !Array.isArray(data.result) || !data.result[0]?.SourceCode) {
          const emptyNatspec = { functions: {} };
          return NextResponse.json({ result: emptyNatspec, cached: false }, { headers: cacheHeaders });
        }

        let sourceCode = data.result[0].SourceCode;

        // Handle JSON-wrapped source (multi-file contracts)
        if (sourceCode.startsWith("{")) {
          try {
            if (sourceCode.startsWith("{{")) {
              sourceCode = sourceCode.slice(1, -1);
            }
            const parsed = JSON.parse(sourceCode);
            const sources = parsed.sources || parsed;
            sourceCode = Object.values(sources)
              .map((s: unknown) => (s as { content?: string }).content || s)
              .join("\n");
          } catch {
            // Not JSON, use as-is
          }
        }

        // Detect language and parse accordingly
        const sourceResult = data.result[0];
        const isVyper =
          sourceCode.includes("@version") ||
          sourceCode.includes("# @") ||
          sourceResult.CompilerVersion?.toLowerCase().includes("vyper");

        const natspec = isVyper ? parseVyperNatSpec(sourceCode) : parseSolidityNatSpec(sourceCode);

        // Cache in KV (only if we found something)
        if (kv && (Object.keys(natspec.functions).length > 0 || natspec.contractNotice)) {
          await kv.put(cacheKey, JSON.stringify(natspec), { expirationTtl: CACHE_TTL });
        }

        return NextResponse.json({ result: natspec, cached: false }, { headers: cacheHeaders });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Explorer API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

// Proxy contract detection and implementation lookup
const PROXY_CONTRACT_NAMES = [
  "TransparentUpgradeableProxy",
  "ERC1967Proxy",
  "AdminUpgradeabilityProxy",
  "BeaconProxy",
  "UUPSUpgradeable",
  "Proxy",
  "FiatTokenProxy",
  "InitializableAdminUpgradeabilityProxy",
  "OwnedUpgradeabilityProxy",
  "UpgradeabilityProxy",
];

function isProxyContract(contractName: string): boolean {
  return PROXY_CONTRACT_NAMES.some(
    (proxy) => contractName.toLowerCase().includes(proxy.toLowerCase())
  );
}

// Common proxy implementation storage slots
const IMPLEMENTATION_SLOTS = [
  // EIP-1967 implementation slot
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  // OpenZeppelin's older implementation slot
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  // EIP-1822 (UUPS) logic slot
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
  // Custom slots used by some protocols
  "0x0000000000000000000000000000000000000000000000000000000000000000", // slot 0
];

async function getImplementationAddress(
  proxyAddress: string,
  chainId: string,
  _apiKey: string
): Promise<string | null> {
  try {
    const rpcUrl = chainId === "1" ? "https://eth.llamarpc.com" : null;
    if (!rpcUrl) return null;

    // Try each known implementation slot
    for (const slot of IMPLEMENTATION_SLOTS) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getStorageAt",
          params: [proxyAddress, slot, "latest"],
          id: 1,
        }),
      });

      const data = (await response.json()) as { result?: string };
      if (data.result && data.result !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        // Extract address from 32-byte slot (last 20 bytes)
        const implAddress = "0x" + data.result.slice(-40);
        // Validate it's a different address and looks like a valid address
        if (
          implAddress.toLowerCase() !== proxyAddress.toLowerCase() &&
          implAddress !== "0x0000000000000000000000000000000000000000"
        ) {
          return implAddress;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchContractName(
  address: string,
  chainId: string,
  apiKey: string
): Promise<string | null> {
  try {
    const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
    const response = await rateLimitedFetch(url);
    const data = (await response.json()) as EtherscanResponse;

    if (data.status !== "1" || !Array.isArray(data.result) || !data.result[0]) {
      return null;
    }

    return data.result[0].ContractName || null;
  } catch {
    return null;
  }
}

// NatSpec parsing functions
interface FunctionDoc {
  notice?: string;
  dev?: string;
  params?: Record<string, string>;
  returns?: string;
}

interface NatSpec {
  contractNotice?: string;
  contractDev?: string;
  functions: Record<string, FunctionDoc>;
}

function parseVyperNatSpec(source: string): NatSpec {
  const natspec: NatSpec = { functions: {} };

  const contractDocMatch = source.match(/^[\s\S]*?"""([\s\S]*?)"""/);
  if (contractDocMatch) {
    const docstring = contractDocMatch[1];
    const noticeMatch = docstring.match(/@notice\s+([\s\S]*?)(?=@\w+|$)/);
    const devMatch = docstring.match(/@dev\s+([\s\S]*?)(?=@\w+|$)/);
    if (noticeMatch) natspec.contractNotice = noticeMatch[1].trim();
    if (devMatch) natspec.contractDev = devMatch[1].trim();
  }

  const parseDocstring = (docstring: string): FunctionDoc => {
    const funcDoc: FunctionDoc = {};
    const noticeMatch = docstring.match(/@notice\s+([\s\S]*?)(?=@\w+|$)/);
    const devMatch = docstring.match(/@dev\s+([\s\S]*?)(?=@\w+|$)/);
    const returnMatch = docstring.match(/@return\s+([\s\S]*?)(?=@\w+|$)/);

    if (noticeMatch) funcDoc.notice = noticeMatch[1].trim();
    if (devMatch) funcDoc.dev = devMatch[1].trim();
    if (returnMatch) funcDoc.returns = returnMatch[1].trim();

    const paramMatches = docstring.matchAll(/@param\s+(\w+)\s+([\s\S]*?)(?=@\w+|$)/g);
    for (const paramMatch of paramMatches) {
      if (!funcDoc.params) funcDoc.params = {};
      funcDoc.params[paramMatch[1]] = paramMatch[2].trim();
    }
    return funcDoc;
  };

  const beforePattern =
    /"""([\s\S]*?)"""\s*\n\s*@(?:external|view|pure|internal)\s*\n(?:@[^\n]*\n)*\s*def\s+(\w+)/g;
  let match;
  while ((match = beforePattern.exec(source)) !== null) {
    const funcDoc = parseDocstring(match[1]);
    if (Object.keys(funcDoc).length > 0) {
      natspec.functions[match[2]] = funcDoc;
    }
  }

  const afterPattern =
    /(?:@(?:external|view|pure|internal)\s*\n(?:@[^\n]*\n)*\s*)?def\s+(\w+)\s*\([^)]*\)[^:]*:\s*\n\s*"""([\s\S]*?)"""/g;
  while ((match = afterPattern.exec(source)) !== null) {
    const funcName = match[1];
    if (!natspec.functions[funcName]) {
      const funcDoc = parseDocstring(match[2]);
      if (Object.keys(funcDoc).length > 0) {
        natspec.functions[funcName] = funcDoc;
      }
    }
  }

  return natspec;
}

function parseSolidityNatSpec(source: string): NatSpec {
  const natspec: NatSpec = { functions: {} };

  const funcPattern = /(?:\/\/\/[^\n]*\n|\/\*\*[\s\S]*?\*\/)\s*function\s+(\w+)/g;
  let match;
  while ((match = funcPattern.exec(source)) !== null) {
    const commentBlock = match[0];
    const funcName = match[1];

    const funcDoc: FunctionDoc = {};
    const noticeMatch = commentBlock.match(/@notice\s+([^\n@]*)/);
    const devMatch = commentBlock.match(/@dev\s+([^\n@]*)/);
    const returnMatch = commentBlock.match(/@return\s+([^\n@]*)/);

    if (noticeMatch) funcDoc.notice = noticeMatch[1].trim();
    if (devMatch) funcDoc.dev = devMatch[1].trim();
    if (returnMatch) funcDoc.returns = returnMatch[1].trim();

    const paramMatches = commentBlock.matchAll(/@param\s+(\w+)\s+([^\n@]*)/g);
    for (const paramMatch of paramMatches) {
      if (!funcDoc.params) funcDoc.params = {};
      funcDoc.params[paramMatch[1]] = paramMatch[2].trim();
    }

    if (Object.keys(funcDoc).length > 0) {
      natspec.functions[funcName] = funcDoc;
    }
  }

  return natspec;
}
