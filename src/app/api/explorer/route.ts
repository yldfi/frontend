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
const CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

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

// Rate limiting
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
        const cacheKey = `abi_${chainId}_${normalizedAddress}`;

        // Check KV cache first
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: JSON.parse(cached), cached: true });
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

        return NextResponse.json({ result: abi, cached: false });
      }

      case "getName": {
        const cacheKey = `name_${chainId}_${normalizedAddress}`;

        // Check KV cache first
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: cached, cached: true });
          }
        }

        // Fetch from Etherscan
        const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
        const response = await rateLimitedFetch(url);
        const data = (await response.json()) as EtherscanResponse;

        if (data.status !== "1" || !Array.isArray(data.result) || !data.result[0]) {
          return NextResponse.json({ result: null, cached: false });
        }

        const name = data.result[0].ContractName || null;

        // Cache in KV (only if we got a name)
        if (kv && name) {
          await kv.put(cacheKey, name, { expirationTtl: CACHE_TTL });
        }

        return NextResponse.json({ result: name, cached: false });
      }

      case "getNatSpec": {
        const cacheKey = `natspec_${chainId}_${normalizedAddress}`;

        // Check KV cache first
        if (kv) {
          const cached = await kv.get(cacheKey);
          if (cached) {
            return NextResponse.json({ result: JSON.parse(cached), cached: true });
          }
        }

        // Fetch from Etherscan
        const url = `${ETHERSCAN_API_BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
        const response = await rateLimitedFetch(url);
        const data = (await response.json()) as EtherscanResponse;

        if (data.status !== "1" || !Array.isArray(data.result) || !data.result[0]?.SourceCode) {
          const emptyNatspec = { functions: {} };
          return NextResponse.json({ result: emptyNatspec, cached: false });
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

        return NextResponse.json({ result: natspec, cached: false });
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
