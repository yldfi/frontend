import { formatUnits } from "viem";

// Default gas estimates for different operation types (in gas units)
const DEFAULT_GAS_ESTIMATE = 300_000n; // Simple swap
const GAS_BUFFER_MULTIPLIER = 150n; // 1.5x buffer for gas price fluctuation
const GAS_BUFFER_DIVISOR = 100n;

/**
 * Calculate the maximum ETH amount that can be used as input,
 * reserving enough ETH for gas costs.
 *
 * @param balance - User's ETH balance in wei
 * @param gasPrice - Current gas price in wei (from useGasPrice)
 * @param gasEstimate - Estimated gas units for the transaction (optional)
 * @returns Maximum usable ETH amount formatted as a string, or "0" if insufficient
 */
export function getMaxEthAmount(
  balance: bigint,
  gasPrice: bigint | undefined,
  gasEstimate?: bigint,
): string {
  if (!gasPrice) {
    // No gas price available — apply a conservative flat reserve (0.01 ETH)
    const reserve = 10_000_000_000_000_000n; // 0.01 ETH
    const max = balance > reserve ? balance - reserve : 0n;
    return formatUnits(max, 18);
  }

  const gas = gasEstimate ?? DEFAULT_GAS_ESTIMATE;
  const gasCost = (gas * gasPrice * GAS_BUFFER_MULTIPLIER) / GAS_BUFFER_DIVISOR;
  const max = balance > gasCost ? balance - gasCost : 0n;
  return formatUnits(max, 18);
}
