import type { PublicClient } from "viem";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";

const CRV_ADDRESS = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const ZERO_FIRST_APPROVAL_TOKENS = new Set([
  CRV_ADDRESS.toLowerCase(),
  USDT_ADDRESS.toLowerCase(),
]);

export function requiresZeroFirstApproval(token: string | undefined): boolean {
  return !!token && ZERO_FIRST_APPROVAL_TOKENS.has(token.toLowerCase());
}

export async function shouldResetApprovalToZeroFirst(params: {
  publicClient?: PublicClient | null;
  owner?: `0x${string}`;
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
  currentAllowance?: bigint;
}): Promise<boolean> {
  if (params.amount === 0n || !requiresZeroFirstApproval(params.token)) return false;

  let currentAllowance = params.currentAllowance;
  if (currentAllowance === undefined && params.publicClient && params.owner) {
    try {
      currentAllowance = await params.publicClient.readContract({
        address: params.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "allowance",
        args: [params.owner, params.spender],
      });
    } catch {
      // For known zero-first tokens, prefer the harmless reset path over a
      // direct nonzero approval that can revert when allowance is nonzero.
      return true;
    }
  }

  return currentAllowance === undefined ? true : currentAllowance > 0n;
}
