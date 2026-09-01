import { describe, expect, it } from "vitest";

import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import {
  buildApprovalSimulationTransaction,
  buildTenderlySimulationPayload,
  parseApprovalSimulationTransactions,
  selectFinalTenderlySimulation,
  type TenderlySimulationRequest,
} from "@/lib/tenderly-simulation-bundle";
import { encodeFunctionData } from "viem";

const TOKEN = "0x1111111111111111111111111111111111111111";
const OTHER_TOKEN = "0x2222222222222222222222222222222222222222";
const SPENDER = "0x3333333333333333333333333333333333333333";
const OTHER_SPENDER = "0x4444444444444444444444444444444444444444";
const OWNER = "0x5555555555555555555555555555555555555555";

const zapRequest: TenderlySimulationRequest = {
  network_id: "1",
  from: OWNER,
  to: SPENDER,
  input: "0xabcdef",
  value: "0",
  save: true,
  save_if_fails: true,
  simulation_type: "quick",
};

describe("Tenderly approval bundles", () => {
  it("accepts a single exact ERC20 approval", () => {
    const approval = buildApprovalSimulationTransaction(TOKEN, SPENDER, 123n);

    expect(parseApprovalSimulationTransactions([approval], TOKEN, SPENDER)).toEqual([approval]);
  });

  it("accepts a zero-reset followed by a nonzero approval", () => {
    const approvals = [
      buildApprovalSimulationTransaction(TOKEN, SPENDER, 0n),
      buildApprovalSimulationTransaction(TOKEN, SPENDER, 123n),
    ];

    expect(parseApprovalSimulationTransactions(approvals, TOKEN, SPENDER)).toEqual(approvals);
  });

  it("rejects approval calls for another token or spender", () => {
    const wrongToken = buildApprovalSimulationTransaction(OTHER_TOKEN, SPENDER, 123n);
    const wrongSpender = buildApprovalSimulationTransaction(TOKEN, OTHER_SPENDER, 123n);

    expect(() => parseApprovalSimulationTransactions([wrongToken], TOKEN, SPENDER))
      .toThrow("must target the input token");
    expect(() => parseApprovalSimulationTransactions([wrongSpender], TOKEN, SPENDER))
      .toThrow("invalid spender");
  });

  it("rejects ETH value, arbitrary calldata, and extra setup calls", () => {
    const approval = buildApprovalSimulationTransaction(TOKEN, SPENDER, 123n);
    const transferCalldata = encodeFunctionData({
      abi: ERC20_APPROVAL_ABI,
      functionName: "allowance",
      args: [OWNER, SPENDER],
    });

    expect(() => parseApprovalSimulationTransactions(
      [{ ...approval, value: "1" }],
      TOKEN,
      SPENDER,
    )).toThrow("must not send ETH");
    expect(() => parseApprovalSimulationTransactions(
      [{ ...approval, data: transferCalldata }],
      TOKEN,
      SPENDER,
    )).toThrow("exact approve calldata");
    expect(() => parseApprovalSimulationTransactions(
      [approval, approval, approval],
      TOKEN,
      SPENDER,
    )).toThrow("At most two");
  });

  it("rejects invalid approval sequences", () => {
    const zero = buildApprovalSimulationTransaction(TOKEN, SPENDER, 0n);
    const nonzero = buildApprovalSimulationTransaction(TOKEN, SPENDER, 123n);

    expect(() => parseApprovalSimulationTransactions([zero], TOKEN, SPENDER))
      .toThrow("greater than zero");
    expect(() => parseApprovalSimulationTransactions([nonzero, nonzero], TOKEN, SPENDER))
      .toThrow("zero-reset");
  });

  it("uses the single-simulation endpoint when no approval was just sent", () => {
    expect(buildTenderlySimulationPayload(zapRequest, [])).toEqual({
      endpoint: "simulate",
      body: zapRequest,
      expectedResults: 1,
    });
  });

  it("places approvals before the zap in a same-block simulation bundle", () => {
    const approval = buildApprovalSimulationTransaction(TOKEN, SPENDER, 123n);
    const built = buildTenderlySimulationPayload(zapRequest, [approval]);

    expect(built.endpoint).toBe("simulate-bundle");
    expect(built.expectedResults).toBe(2);
    expect(built.body).toEqual({
      simulations: [
        expect.objectContaining({
          from: OWNER,
          to: TOKEN,
          input: approval.data,
          value: "0",
        }),
        zapRequest,
      ],
    });
  });

  it("selects the final zap result from the REST bundle response", () => {
    const final = { simulation: { id: "zap", status: true } };
    const selected = selectFinalTenderlySimulation({
      simulation_results: [
        { simulation: { id: "approval", status: true } },
        final,
      ],
    }, 2);

    expect(selected).toEqual({
      result: final,
      complete: true,
      receivedResults: 2,
    });
  });

  it("marks an early-returned bundle as incomplete", () => {
    const failure = { simulation: { id: "approval", status: false } };

    expect(selectFinalTenderlySimulation({ simulation_results: [failure] }, 2)).toEqual({
      result: failure,
      complete: false,
      receivedResults: 1,
    });
  });
});
