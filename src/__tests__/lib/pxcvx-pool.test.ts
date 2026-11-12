// @vitest-environment node
import type { TwocryptoParams } from "@/lib/curve";
import { PIREX } from "@/config/vaults";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetCryptoSwapParams,
  mockCryptoSwapGetDy,
  mockFindPegPoint,
  mockRpcWithFallback,
} = vi.hoisted(() => ({
  mockGetCryptoSwapParams: vi.fn(),
  mockCryptoSwapGetDy: vi.fn(),
  mockFindPegPoint: vi.fn(),
  mockRpcWithFallback: vi.fn(),
}));

// The pool helper only reaches Curve through these three functions, and through
// the RPC fallback in @/lib/enso/api; everything else stays real.
vi.mock("@/lib/curve", () => ({
  getCryptoSwapParams: mockGetCryptoSwapParams,
  cryptoswap: {
    getDy: mockCryptoSwapGetDy,
    findPegPoint: mockFindPegPoint,
  },
}));

vi.mock("@/lib/enso/api", () => ({
  rpcWithFallback: mockRpcWithFallback,
}));

import {
  getLpxCvxToCvxSwapRate,
  getOptimalPxCvxSwapAmount,
  getPxCvxSwapRate,
} from "@/lib/enso/pxcvx-pool";

// Any well-formed Twocrypto snapshot; the mocked math treats it as opaque.
const PARAMS: TwocryptoParams = {
  A: 400000n,
  gamma: 145000000000000n,
  D: 2000000000000000000000n,
  midFee: 4000000n,
  outFee: 26000000n,
  feeGamma: 230000000000000n,
  priceScale: 1000000000000000000n,
  balances: [1000000000000000000000n, 1000000000000000000000n],
};

const AMOUNT = 1000n;
const AMOUNT_IN = AMOUNT.toString();

// get_dy(uint256,uint256,uint256) calldata: selector plus three ABI words.
const word = (value: bigint) => value.toString(16).padStart(64, "0");
/** An eth_call result in the shape a node returns: a 32-byte hex word. */
const hexWord = (value: bigint) => `0x${word(value)}`;
const fallbackCalldata = (i: number, j: number, amount: bigint) =>
  `0x556d6e9f${word(BigInt(i))}${word(BigInt(j))}${word(amount)}`;

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const RATE_FUNCTIONS = [
  { name: "getPxCvxSwapRate (CVX → lpxCVX)", fn: getPxCvxSwapRate, i: 0, j: 1 },
  { name: "getLpxCvxToCvxSwapRate (lpxCVX → CVX)", fn: getLpxCvxToCvxSwapRate, i: 1, j: 0 },
] as const;

describe.each(RATE_FUNCTIONS)("$name", ({ fn, i, j }) => {
  it("returns the off-chain getDy result without an RPC call", async () => {
    mockGetCryptoSwapParams.mockResolvedValue(PARAMS);
    mockCryptoSwapGetDy.mockReturnValue(AMOUNT - 1n);

    await expect(fn(AMOUNT_IN)).resolves.toBe(AMOUNT - 1n);

    expect(mockGetCryptoSwapParams).toHaveBeenCalledTimes(1);
    expect(mockGetCryptoSwapParams).toHaveBeenCalledWith(PIREX.LPXCVX_CVX_POOL);
    expect(mockCryptoSwapGetDy).toHaveBeenCalledTimes(1);
    expect(mockCryptoSwapGetDy).toHaveBeenCalledWith(PARAMS, i, j, AMOUNT);
    expect(mockRpcWithFallback).not.toHaveBeenCalled();
  });

  it("falls back to eth_call when the pool parameters cannot be fetched", async () => {
    mockGetCryptoSwapParams.mockRejectedValue(new Error("pool parameters unavailable"));
    mockRpcWithFallback.mockResolvedValue({ result: hexWord(12345n) });

    await expect(fn(AMOUNT_IN)).resolves.toBe(12345n);

    expect(mockRpcWithFallback).toHaveBeenCalledTimes(1);
    expect(mockRpcWithFallback).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: PIREX.LPXCVX_CVX_POOL, data: fallbackCalldata(i, j, AMOUNT) },
        "latest",
      ],
    });
    expect(mockCryptoSwapGetDy).not.toHaveBeenCalled();
  });

  it("falls back to eth_call when the off-chain math throws", async () => {
    mockGetCryptoSwapParams.mockResolvedValue(PARAMS);
    mockCryptoSwapGetDy.mockImplementation(() => {
      throw new Error("off-chain math failed");
    });
    mockRpcWithFallback.mockResolvedValue({ result: hexWord(777n) });

    await expect(fn(AMOUNT_IN)).resolves.toBe(777n);

    expect(mockRpcWithFallback).toHaveBeenCalledTimes(1);
    expect(mockRpcWithFallback).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: PIREX.LPXCVX_CVX_POOL, data: fallbackCalldata(i, j, AMOUNT) },
        "latest",
      ],
    });
  });

  it("returns 0n when the fallback reply has no result", async () => {
    mockGetCryptoSwapParams.mockRejectedValue(new Error("pool parameters unavailable"));
    mockRpcWithFallback.mockResolvedValue({});

    await expect(fn(AMOUNT_IN)).resolves.toBe(0n);

    expect(mockRpcWithFallback).toHaveBeenCalledTimes(1);
  });

  it("rejects when the fallback reply is an empty hex string", async () => {
    mockGetCryptoSwapParams.mockRejectedValue(new Error("pool parameters unavailable"));
    // BigInt("0x") throws, and the helper does not guard the decode.
    mockRpcWithFallback.mockResolvedValue({ result: "0x" });

    await expect(fn(AMOUNT_IN)).rejects.toThrow(SyntaxError);

    expect(mockRpcWithFallback).toHaveBeenCalledTimes(1);
  });

  it("rejects when both the off-chain math and the fallback fail", async () => {
    mockGetCryptoSwapParams.mockRejectedValue(new Error("pool parameters unavailable"));
    mockRpcWithFallback.mockRejectedValue(new Error("rpc unavailable"));

    await expect(fn(AMOUNT_IN)).rejects.toThrow("rpc unavailable");
  });
});

const TOTAL = 1000n;

// Rate for the total is just below 1:1, so the peg-point branch is reached. The
// off-chain rate for any other amount stays at 1:1 or better: if the re-check
// consulted it (as the old code did) the split would look fine and the chain
// would never be read.
const arrangePegPoint = (pegPoint: bigint) => {
  mockGetCryptoSwapParams.mockResolvedValue(PARAMS);
  mockCryptoSwapGetDy.mockImplementation(
    (_params: unknown, _i: number, _j: number, dx: bigint) =>
      dx === TOTAL ? TOTAL - 1n : dx
  );
  mockFindPegPoint.mockReturnValue(pegPoint);
};

/** The re-check is one eth_call to the pool's get_dy(i, j, dx). */
const expectPoolDyRead = (amount: bigint) => {
  expect(mockRpcWithFallback).toHaveBeenCalledTimes(1);
  expect(mockRpcWithFallback).toHaveBeenCalledWith({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      { to: PIREX.LPXCVX_CVX_POOL, data: fallbackCalldata(0, 1, amount) },
      "latest",
    ],
  });
};

const expectNoPoolRead = () => {
  expect(mockRpcWithFallback).not.toHaveBeenCalled();
};

type SplitCase = {
  label: string;
  total: string;
  arrange: () => void;
  swapAmount: bigint;
  mintAmount: bigint;
  verify?: () => void;
};

const SPLIT_CASES: SplitCase[] = [
  {
    label: "returns zeros for a zero total without reading the pool",
    total: "0",
    arrange: () => {},
    swapAmount: 0n,
    mintAmount: 0n,
    verify: () => {
      expect(mockGetCryptoSwapParams).not.toHaveBeenCalled();
      expect(mockFindPegPoint).not.toHaveBeenCalled();
      expectNoPoolRead();
    },
  },
  {
    label: "swaps everything when the total already earns a bonus",
    total: TOTAL.toString(),
    arrange: () => {
      mockGetCryptoSwapParams.mockResolvedValue(PARAMS);
      mockCryptoSwapGetDy.mockReturnValue(TOTAL + 100n);
    },
    swapAmount: TOTAL,
    mintAmount: 0n,
    verify: () => {
      expect(mockFindPegPoint).not.toHaveBeenCalled();
      expectNoPoolRead();
    },
  },
  {
    label: "swaps everything at exactly 1:1",
    total: TOTAL.toString(),
    arrange: () => {
      mockGetCryptoSwapParams.mockResolvedValue(PARAMS);
      mockCryptoSwapGetDy.mockReturnValue(TOTAL);
    },
    swapAmount: TOTAL,
    mintAmount: 0n,
    verify: () => {
      expect(mockFindPegPoint).not.toHaveBeenCalled();
      expectNoPoolRead();
    },
  },
  {
    label: "mints everything when there is no peg point above zero",
    total: TOTAL.toString(),
    arrange: () => arrangePegPoint(0n),
    swapAmount: 0n,
    mintAmount: TOTAL,
    verify: () => {
      expect(mockCryptoSwapGetDy).toHaveBeenCalledTimes(1);
      expect(mockFindPegPoint).toHaveBeenCalledWith(PARAMS, 0, 1);
      expectNoPoolRead();
    },
  },
  {
    label: "swaps the peg point when the chain confirms it",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockResolvedValue({ result: hexWord(450n) });
    },
    swapAmount: 400n,
    mintAmount: 600n,
    verify: () => {
      expectPoolDyRead(400n);
      expect(mockCryptoSwapGetDy).toHaveBeenCalledTimes(1);
    },
  },
  {
    label: "swaps the peg point at exactly 1:1 on chain",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockResolvedValue({ result: hexWord(400n) });
    },
    swapAmount: 400n,
    mintAmount: 600n,
    verify: () => {
      expectPoolDyRead(400n);
    },
  },
  {
    label: "reduces the peg point by 1% when the chain comes up short",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockResolvedValue({ result: hexWord(399n) });
    },
    swapAmount: 396n,
    mintAmount: 604n,
    verify: () => {
      expectPoolDyRead(400n);
    },
  },
  {
    label: "reduces the peg point by 2% when the chain reply has no result",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockResolvedValue({});
    },
    swapAmount: 392n,
    mintAmount: 608n,
    verify: () => {
      expectPoolDyRead(400n);
    },
  },
  {
    label: "reduces the peg point by 2% when the chain reply is an empty hex string",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockResolvedValue({ result: "0x" });
    },
    swapAmount: 392n,
    mintAmount: 608n,
    verify: () => {
      expectPoolDyRead(400n);
    },
  },
  {
    label: "reduces the peg point by 2% when the chain read fails",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockRejectedValue(new Error("rpc unavailable"));
    },
    swapAmount: 392n,
    mintAmount: 608n,
    verify: () => {
      expect(mockRpcWithFallback).toHaveBeenCalledTimes(1);
    },
  },
  {
    label: "trusts the chain even when the off-chain rate at the peg point looks fine",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(400n);
      mockRpcWithFallback.mockResolvedValue({ result: hexWord(399n) });
    },
    swapAmount: 396n,
    mintAmount: 604n,
    verify: () => {
      expectPoolDyRead(400n);
      // The off-chain mock would return 400 for dx = 400; it must not be asked.
      expect(mockCryptoSwapGetDy).not.toHaveBeenCalledWith(PARAMS, 0, 1, 400n);
      expect(mockCryptoSwapGetDy).toHaveBeenCalledTimes(1);
    },
  },
  {
    label: "caps the swap at the total when the peg point is above it",
    total: TOTAL.toString(),
    arrange: () => {
      arrangePegPoint(5000n);
      mockRpcWithFallback.mockResolvedValue({ result: hexWord(5000n) });
    },
    swapAmount: TOTAL,
    mintAmount: 0n,
    verify: () => {
      expectPoolDyRead(5000n);
    },
  },
  {
    label: "mints everything and logs once when the pool parameters cannot be fetched",
    total: TOTAL.toString(),
    arrange: () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockGetCryptoSwapParams.mockRejectedValue(new Error("pool parameters unavailable"));
    },
    swapAmount: 0n,
    mintAmount: TOTAL,
    verify: () => {
      expect(console.error).toHaveBeenCalledTimes(1);
      expectNoPoolRead();
    },
  },
];

describe("getOptimalPxCvxSwapAmount", () => {
  it.each(SPLIT_CASES)("$label", async ({ total, arrange, swapAmount, mintAmount, verify }) => {
    arrange();

    const result = await getOptimalPxCvxSwapAmount(total);

    expect(result).toEqual({ swapAmount, mintAmount });
    // The two parts are amounts inside one transaction: they must add up exactly.
    expect(result.swapAmount + result.mintAmount).toBe(BigInt(total));
    verify?.();
  });
});

/** The re-check is capped at 2.5 seconds; these cases control its timing. */
const PEG_RECHECK_CAP_MS = 2_500;

describe("getOptimalPxCvxSwapAmount peg-point re-check time cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cuts 2% when the re-check never settles", async () => {
    arrangePegPoint(400n);
    mockRpcWithFallback.mockReturnValue(new Promise(() => {}));

    const pending = getOptimalPxCvxSwapAmount(TOTAL.toString());
    await vi.advanceTimersByTimeAsync(PEG_RECHECK_CAP_MS);

    await expect(pending).resolves.toEqual({ swapAmount: 392n, mintAmount: 608n });
  });

  it("keeps the peg point when the re-check beats the cap", async () => {
    arrangePegPoint(400n);
    mockRpcWithFallback.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ result: hexWord(450n) }), 2_000);
        })
    );

    const pending = getOptimalPxCvxSwapAmount(TOTAL.toString());
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toEqual({ swapAmount: 400n, mintAmount: 600n });
    // The cap timer must not outlive the settled read.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts 2% when the re-check rejects after the cap", async () => {
    arrangePegPoint(400n);
    mockRpcWithFallback.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("rpc unavailable")), 5_000);
        })
    );

    const pending = getOptimalPxCvxSwapAmount(TOTAL.toString());
    await vi.advanceTimersByTimeAsync(PEG_RECHECK_CAP_MS);

    await expect(pending).resolves.toEqual({ swapAmount: 392n, mintAmount: 608n });

    // The late rejection is swallowed: the test completes with no unhandled rejection.
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("keeps the peg point for an immediate reply and leaves no timer behind", async () => {
    arrangePegPoint(400n);
    mockRpcWithFallback.mockResolvedValue({ result: hexWord(450n) });

    await expect(getOptimalPxCvxSwapAmount(TOTAL.toString())).resolves.toEqual({
      swapAmount: 400n,
      mintAmount: 600n,
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
