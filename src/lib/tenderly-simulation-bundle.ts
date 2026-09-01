import { decodeFunctionData, encodeFunctionData, isAddress } from "viem";
import type { Address, Hex } from "viem";

import { ERC20_APPROVAL_ABI } from "@/lib/abis";

const APPROVE_CALLDATA_LENGTH = 2 + 8 + 64 + 64;
const MAX_APPROVAL_TRANSACTIONS = 2;

export interface ApprovalSimulationTransaction {
  to: Address;
  data: Hex;
  value: string;
}

export interface TenderlySimulationRequest {
  network_id: string;
  from: string;
  to: string;
  input: string;
  value: string;
  gas?: number;
  save: boolean;
  save_if_fails: boolean;
  simulation_type: "quick" | "full";
  state_objects?: Record<string, { storage: Record<string, string> }>;
}

export function buildApprovalSimulationTransaction(
  token: Address,
  spender: Address,
  amount: bigint,
): ApprovalSimulationTransaction {
  return {
    to: token,
    data: encodeFunctionData({
      abi: ERC20_APPROVAL_ABI,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: "0",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the client-provided setup calls before including them in a Tenderly
 * bundle. Only one approve, or a zero-reset followed by an approve, is allowed.
 */
export function parseApprovalSimulationTransactions(
  value: unknown,
  inputToken: string | undefined,
  expectedSpender: string,
): ApprovalSimulationTransaction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("approvalTransactions must be an array");
  }
  if (value.length === 0) return [];
  if (value.length > MAX_APPROVAL_TRANSACTIONS) {
    throw new Error("At most two approval transactions are allowed");
  }
  if (!inputToken || !isAddress(inputToken)) {
    throw new Error("A valid input token is required for approval simulation");
  }
  if (!isAddress(expectedSpender)) {
    throw new Error("Invalid approval spender configuration");
  }

  const amounts: bigint[] = [];
  const transactions = value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Invalid approval transaction at index ${index}`);
    }

    const { to, data, value: transactionValue } = candidate;
    if (typeof to !== "string" || !isAddress(to) || to.toLowerCase() !== inputToken.toLowerCase()) {
      throw new Error(`Approval transaction ${index} must target the input token`);
    }
    if (typeof transactionValue !== "string") {
      throw new Error(`Approval transaction ${index} has an invalid value`);
    }
    try {
      if (BigInt(transactionValue) !== 0n) {
        throw new Error(`Approval transaction ${index} must not send ETH`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("must not send ETH")) throw error;
      throw new Error(`Approval transaction ${index} has an invalid value`);
    }
    if (
      typeof data !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(data) ||
      data.length !== APPROVE_CALLDATA_LENGTH
    ) {
      throw new Error(`Approval transaction ${index} must contain exact approve calldata`);
    }

    try {
      const decoded = decodeFunctionData({
        abi: ERC20_APPROVAL_ABI,
        data: data as Hex,
      });
      if (decoded.functionName !== "approve") {
        throw new Error("Unexpected approval function");
      }
      const [spender, amount] = decoded.args;
      if (spender.toLowerCase() !== expectedSpender.toLowerCase()) {
        throw new Error(`Approval transaction ${index} has an invalid spender`);
      }
      amounts.push(amount);
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid spender")) throw error;
      throw new Error(`Approval transaction ${index} must contain exact approve calldata`);
    }

    return {
      to: to as Address,
      data: data as Hex,
      value: transactionValue,
    };
  });

  if (transactions.length === 1 && amounts[0] === 0n) {
    throw new Error("The final approval amount must be greater than zero");
  }
  if (transactions.length === 2 && (amounts[0] !== 0n || amounts[1] === 0n)) {
    throw new Error("Two approval transactions must be a zero-reset followed by a nonzero approval");
  }

  return transactions;
}

export function buildTenderlySimulationPayload(
  zapRequest: TenderlySimulationRequest,
  approvalTransactions: ApprovalSimulationTransaction[],
): {
  endpoint: "simulate" | "simulate-bundle";
  body: TenderlySimulationRequest | { simulations: TenderlySimulationRequest[] };
  expectedResults: number;
} {
  if (approvalTransactions.length === 0) {
    return { endpoint: "simulate", body: zapRequest, expectedResults: 1 };
  }

  const setupRequests = approvalTransactions.map((transaction) => ({
    network_id: zapRequest.network_id,
    from: zapRequest.from,
    to: transaction.to,
    input: transaction.data,
    value: transaction.value,
    save: true,
    save_if_fails: true,
    simulation_type: zapRequest.simulation_type,
  } satisfies TenderlySimulationRequest));

  return {
    endpoint: "simulate-bundle",
    body: { simulations: [...setupRequests, zapRequest] },
    expectedResults: setupRequests.length + 1,
  };
}

export function selectFinalTenderlySimulation(
  payload: unknown,
  expectedResults: number,
): {
  result: Record<string, unknown>;
  complete: boolean;
  receivedResults: number;
} {
  if (!isRecord(payload)) {
    return { result: {}, complete: false, receivedResults: 0 };
  }
  if (expectedResults === 1) {
    return { result: payload, complete: true, receivedResults: 1 };
  }

  const simulationResults = payload.simulation_results;
  if (!Array.isArray(simulationResults) || simulationResults.length === 0) {
    return { result: {}, complete: false, receivedResults: 0 };
  }

  const finalResult = simulationResults[simulationResults.length - 1];
  return {
    result: isRecord(finalResult) ? finalResult : {},
    complete: simulationResults.length === expectedResults,
    receivedResults: simulationResults.length,
  };
}
