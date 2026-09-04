import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
} from "viem";
import {
  assertProtectedEnsoIntentResponse,
  assertEnsoIntentTxTarget,
  assertValidEnsoIntentRequest,
  getIntentVault,
  getYldVaultToVaultIntentName,
  isStandardYldVaultIntentVault,
  protectEnsoIntentResponse,
  shouldUsePlainTokenSwapIntent,
} from "@/lib/enso-intents";
import { CURVE_CONTROLLERS, LLAMA_AIRFORCE, TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import type { EnsoRouteResponse } from "@/types/enso";

const USER = "0x1000000000000000000000000000000000000001";
const OTHER = "0x2000000000000000000000000000000000000002";
const ONE_ETHER = "1000000000000000000";
const ENSO_ROUTER_V2 = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const ENSO_ROUTER_V1 = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
const ENSO_SHORTCUTS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";
const MORPHO_BUNDLER3 = "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245";
const LEGACY_MORPHO = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
const MORPHO_GENERAL_ADAPTER1 = "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0";
const ZERO_CALLBACK_HASH = `0x${"00".repeat(32)}` as `0x${string}`;
const ENSO_ROUTER_ENTRYPOINT_ABI = parseAbi([
  "function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes)",
  "function routeMulti((uint8 tokenType, bytes data)[] tokensIn, bytes data) payable returns (bytes)",
  "function safeRouteSingle((uint8 tokenType, bytes data) tokenIn, (uint8 tokenType, bytes data) tokenOut, address receiver, bytes data) payable returns (bytes)",
  "function safeRouteMulti((uint8 tokenType, bytes data)[] tokensIn, (uint8 tokenType, bytes data)[] tokensOut, address receiver, bytes data) payable returns (bytes)",
]);
const TOKEN_AMOUNT_PARAMETERS = parseAbiParameters("address token, uint256 amount");
const NATIVE_AMOUNT_PARAMETERS = parseAbiParameters("uint256 amount");
const MORPHO_ADAPTER_ABI = parseAbi([
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  "function morphoWrapperDepositFor(address receiver, uint256 amount)",
]);
const encodeTokenAmount = (token: string, amount = ONE_ETHER) =>
  encodeAbiParameters(TOKEN_AMOUNT_PARAMETERS, [token as `0x${string}`, BigInt(amount)]);
const ROUTE_SINGLE_CALLDATA = encodeFunctionData({
  abi: ENSO_ROUTER_ENTRYPOINT_ABI,
  functionName: "routeSingle",
  args: [{ tokenType: 0, data: "0x" }, "0x1234"],
});
const ROUTE_MULTI_CALLDATA = encodeFunctionData({
  abi: ENSO_ROUTER_ENTRYPOINT_ABI,
  functionName: "routeMulti",
  args: [[], "0x1234"],
});

describe("Enso intent validation", () => {
  it("accepts a plain user-owned token swap intent", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      receiver: USER,
      tokenIn: TOKENS.CVX,
      tokenOut: TOKENS.CVXCRV,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();
  });

  it("rejects slippage above the protected UI ceiling", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      receiver: USER,
      tokenIn: TOKENS.CVX,
      tokenOut: TOKENS.CVXCRV,
      amountIn: ONE_ETHER,
      slippage: "5001",
    })).toThrow("slippage must be between 0 and 5000 basis points");
  });

  it("rejects raw actions on the intent endpoint", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      actions: [],
    })).toThrow("actions is not accepted");
  });

  it("rejects calldata on the intent endpoint", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      tokenIn: TOKENS.CVX,
      tokenOut: TOKENS.CVXCRV,
      amountIn: ONE_ETHER,
      data: "0x1234",
    })).toThrow("data is not accepted");
  });

  it("rejects other raw execution controls on the intent endpoint", () => {
    for (const field of ["innerData", "routingStrategy", "skipQuote", "target"]) {
      expect(() => assertValidEnsoIntentRequest({
        intent: "plainTokenSwap",
        fromAddress: USER,
        tokenIn: TOKENS.CVX,
        tokenOut: TOKENS.CVXCRV,
        amountIn: ONE_ETHER,
        [field]: "0x1234",
      })).toThrow(`${field} is not accepted`);
    }
  });

  it("rejects extra fields outside the intent schema", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      tokenIn: TOKENS.CVX,
      tokenOut: TOKENS.CVXCRV,
      amountIn: ONE_ETHER,
      params: {},
    })).toThrow("params is not accepted");
  });

  it("rejects non-owner receivers for low-risk intents", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      receiver: OTHER,
      tokenIn: TOKENS.CVX,
      tokenOut: TOKENS.CVXCRV,
      amountIn: ONE_ETHER,
    })).toThrow("receiver must match fromAddress");
  });

  it("accepts standard YLD vault zap in and zap out intents", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();
  });

  it("accepts standard YLD vault-to-vault intents", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultToVault",
      fromAddress: USER,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSCVXCRV,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();
  });

  it("accepts special cvgCVX and pxCVX vault zap intents", () => {
    expect(isStandardYldVaultIntentVault(VAULT_ADDRESSES.YSCVGCVX)).toBe(false);
    expect(isStandardYldVaultIntentVault(VAULT_ADDRESSES.YSPXCVX)).toBe(false);

    expect(() => assertValidEnsoIntentRequest({
      intent: "cvgCvxZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "cvgCvxZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "pxCvxZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "pxCvxZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();
  });

  it("accepts external vault zap-in intents into YLD vaults", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "externalVaultZapInToYld",
      fromAddress: USER,
      externalVaultAddress: LLAMA_AIRFORCE.UCRV,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();
  });

  it("accepts liquid-token zap-in intents into external vaults", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "anyToExternalVault",
      fromAddress: USER,
      inputToken: TOKENS.CVX,
      externalVaultAddress: LLAMA_AIRFORCE.UCRV,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();
  });

  it("accepts the remaining named zap intents", () => {
    const cases = [
      {
        intent: "yldVaultToExternalVault",
        fromAddress: USER,
        sourceVault: VAULT_ADDRESSES.YSCVXCRV,
        targetVault: LLAMA_AIRFORCE.UCRV,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "yldVaultToIlliquid",
        fromAddress: USER,
        sourceVault: VAULT_ADDRESSES.YSCVXCRV,
        outputToken: TOKENS.PXCVX,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "specialTokenToExternalVault",
        fromAddress: USER,
        inputToken: TOKENS.PXCVX,
        outputVault: LLAMA_AIRFORCE.UCRV,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "specialTokenToIlliquid",
        fromAddress: USER,
        inputToken: LLAMA_AIRFORCE.UCRV,
        outputToken: TOKENS.CVGCVX,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "externalVaultToAny",
        fromAddress: USER,
        externalVaultAddress: LLAMA_AIRFORCE.UCRV,
        outputToken: TOKENS.CVX,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "illiquidToAny",
        fromAddress: USER,
        inputToken: TOKENS.CVGCVX,
        outputToken: TOKENS.CVX,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "anyToIlliquid",
        fromAddress: USER,
        inputToken: TOKENS.CVX,
        outputToken: TOKENS.LPXCVX,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "legacyMorphoWrap",
        fromAddress: USER,
        outputToken: TOKENS.CVX,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "legacyMorphoZapIn",
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        amountIn: ONE_ETHER,
        slippage: "100",
      },
      {
        intent: "curveLendingRepay",
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        amountIn: ONE_ETHER,
      },
      {
        intent: "curveLendingRepayWithSwap",
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        tokenIn: TOKENS.CVX,
        amountIn: ONE_ETHER,
        slippage: "100",
        inSoftLiquidation: false,
      },
    ] as const;

    for (const request of cases) {
      expect(() => assertValidEnsoIntentRequest(request)).not.toThrow();
    }

    expect(CURVE_CONTROLLERS[VAULT_ADDRESSES.YCVXCRV]).toBeTruthy();
  });

  it("keeps standard zap intents limited to standard vaults", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).toThrow("special asset flow");
  });

  it("rejects special zap intents when the vault asset does not match", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "cvgCvxZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("cvgCVX-backed");

    expect(() => assertValidEnsoIntentRequest({
      intent: "pxCvxZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("pxCVX-backed");
  });

  it("keeps curve repay-with-swap intent limited to repay semantics", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "curveLendingRepayWithSwap",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      tokenIn: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
      closeLoan: true,
      maxRepayAmount: ONE_ETHER,
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "curveLendingRepayWithSwap",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      tokenIn: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
      maxRepayAmount: ONE_ETHER,
    })).toThrow("maxRepayAmount requires closeLoan");

    for (const field of ["withdrawAmount", "withdrawTokenOut"]) {
      expect(() => assertValidEnsoIntentRequest({
        intent: "curveLendingRepayWithSwap",
        fromAddress: USER,
        vaultAddress: VAULT_ADDRESSES.YCVXCRV,
        tokenIn: TOKENS.CVX,
        amountIn: ONE_ETHER,
        slippage: "100",
        [field]: field === "withdrawTokenOut" ? TOKENS.CVX : ONE_ETHER,
      })).toThrow(`${field} is not accepted`);
    }
  });

  it("selects and validates special vault-to-vault intent names", () => {
    expect(getYldVaultToVaultIntentName({
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSCVXCRV,
    })).toBe("yldVaultToVault");

    expect(getYldVaultToVaultIntentName({
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSCVGCVX,
    })).toBe("yldVaultToCvgCvxVault");

    expect(getYldVaultToVaultIntentName({
      sourceVault: VAULT_ADDRESSES.YSCVGCVX,
      targetVault: VAULT_ADDRESSES.YCVXCRV,
    })).toBe("cvgCvxVaultToYldVault");

    expect(getYldVaultToVaultIntentName({
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSPXCVX,
    })).toBe("yldVaultToPxCvxVault");

    expect(getYldVaultToVaultIntentName({
      sourceVault: VAULT_ADDRESSES.YSPXCVX,
      targetVault: VAULT_ADDRESSES.YSCVGCVX,
    })).toBe("pxCvxVaultToYldVault");

    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultToCvgCvxVault",
      fromAddress: USER,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSCVGCVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultToCvgCvxVault",
      fromAddress: USER,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSPXCVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("does not match");
  });

  it("requires explicit slippage for complex server-owned recipes", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "cvgCvxZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).toThrow("slippage is required");

    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultToPxCvxVault",
      fromAddress: USER,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSPXCVX,
      amountIn: ONE_ETHER,
    })).toThrow("slippage is required");

    expect(() => assertValidEnsoIntentRequest({
      intent: "externalVaultZapInToYld",
      fromAddress: USER,
      externalVaultAddress: LLAMA_AIRFORCE.UCRV,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      amountIn: ONE_ETHER,
    })).toThrow("slippage is required");

    expect(() => assertValidEnsoIntentRequest({
      intent: "anyToExternalVault",
      fromAddress: USER,
      inputToken: TOKENS.CVX,
      externalVaultAddress: LLAMA_AIRFORCE.UCRV,
      amountIn: ONE_ETHER,
    })).toThrow("slippage is required");
  });

  it("rejects zero-address and YLD-vault tokens in liquid token fields", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      tokenIn: "0x0000000000000000000000000000000000000000",
      tokenOut: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).toThrow("tokenIn must not be the zero address");

    expect(() => assertValidEnsoIntentRequest({
      intent: "plainTokenSwap",
      fromAddress: USER,
      tokenIn: VAULT_ADDRESSES.YCVXCRV,
      tokenOut: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).toThrow("not a YLD vault");
  });

  it("rejects same-vault and unknown-vault zap intents", () => {
    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultToVault",
      fromAddress: USER,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YCVXCRV,
      amountIn: ONE_ETHER,
    })).toThrow("must be different");

    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultZapOut",
      fromAddress: USER,
      vaultAddress: OTHER,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).toThrow("known YLD vault");

    expect(() => assertValidEnsoIntentRequest({
      intent: "externalVaultZapInToYld",
      fromAddress: USER,
      externalVaultAddress: OTHER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("known external vault");

    expect(() => assertValidEnsoIntentRequest({
      intent: "anyToExternalVault",
      fromAddress: USER,
      inputToken: TOKENS.PXCVX,
      externalVaultAddress: LLAMA_AIRFORCE.UCRV,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("specialTokenToExternalVault");

    expect(() => assertValidEnsoIntentRequest({
      intent: "anyToExternalVault",
      fromAddress: USER,
      inputToken: TOKENS.CVX,
      externalVaultAddress: OTHER,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("known external vault");

    expect(() => assertValidEnsoIntentRequest({
      intent: "anyToIlliquid",
      fromAddress: USER,
      inputToken: LEGACY_MORPHO,
      outputToken: TOKENS.PXCVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("legacy MORPHO");

    expect(() => assertValidEnsoIntentRequest({
      intent: "externalVaultToAny",
      fromAddress: USER,
      externalVaultAddress: LLAMA_AIRFORCE.UCRV,
      outputToken: TOKENS.CVGCVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    })).toThrow("supported illiquid token");

    expect(() => assertValidEnsoIntentRequest({
      intent: "curveLendingRepay",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVXCRV,
      amountIn: ONE_ETHER,
    })).toThrow("Curve lending collateral vault");
  });

  it("looks up migrated vault metadata without accepting the zero address", () => {
    expect(getIntentVault(VAULT_ADDRESSES.YCVXCRV)?.assetAddress).toBe(TOKENS.CVXCRV);
    expect(getIntentVault("0x0000000000000000000000000000000000000000")).toBeUndefined();
  });

  it("uses the plain token swap intent only when the receiver is the owner", () => {
    expect(shouldUsePlainTokenSwapIntent({ fromAddress: USER })).toBe(true);
    expect(shouldUsePlainTokenSwapIntent({ fromAddress: USER, receiver: USER.toLowerCase() })).toBe(true);
    expect(shouldUsePlainTokenSwapIntent({ fromAddress: USER, receiver: OTHER })).toBe(false);
  });

  it("allows only per-intent Enso router transaction targets in intent responses", () => {
    expect(() => assertEnsoIntentTxTarget("cvgCvxZapOut", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("externalVaultZapInToYld", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {
        [VAULT_ADDRESSES.YCVXCRV]: "1",
      },
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("anyToExternalVault", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {
        [LLAMA_AIRFORCE.UCRV]: "1",
      },
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("yldVaultToExternalVault", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {
        [LLAMA_AIRFORCE.UCRV]: "1",
      },
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("curveLendingRepayWithSwap", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {},
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("specialTokenToExternalVault", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_MULTI_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {
        [LLAMA_AIRFORCE.UCRV]: "1",
      },
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("legacyMorphoWrap", {
      tx: {
        to: MORPHO_BUNDLER3,
        data: "0x",
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {
        [TOKENS.CVX]: "1",
      },
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget("cvgCvxZapOut", {
      tx: {
        to: ENSO_SHORTCUTS,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("forbidden transaction target");

    expect(() => assertEnsoIntentTxTarget("cvgCvxZapOut", {
      tx: {
        to: OTHER,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {},
    })).toThrow("unexpected transaction target");

    expect(() => assertEnsoIntentTxTarget("plainTokenSwap", {
      tx: {
        to: MORPHO_BUNDLER3,
        data: "0x",
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("unexpected transaction target");
  });

  it("rejects malformed Enso intent response payloads before returning them", () => {
    expect(() => assertEnsoIntentTxTarget("plainTokenSwap", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: "not-hex",
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("tx.data");

    expect(() => assertEnsoIntentTxTarget("plainTokenSwap", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_SINGLE_CALLDATA,
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {
        [TOKENS.CVX]: "1",
        notAddress: "1",
      },
    })).toThrow("invalid token address");
  });

  it("rejects unexpected or undecodable Enso router calldata", () => {
    expect(() => assertEnsoIntentTxTarget("plainTokenSwap", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: ROUTE_MULTI_CALLDATA,
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("forbidden router selector");

    expect(() => assertEnsoIntentTxTarget("plainTokenSwap", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: "0xdeadbeef",
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("unexpected router selector");

    expect(() => assertEnsoIntentTxTarget("plainTokenSwap", {
      tx: {
        to: ENSO_ROUTER_V2,
        data: "0xb94c3609",
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("undecodable router calldata");
  });
});

describe("Enso intent response protection", () => {
  const swapRequest = {
    intent: "plainTokenSwap" as const,
    fromAddress: USER,
    receiver: USER,
    tokenIn: TOKENS.CVX,
    tokenOut: TOKENS.CVXCRV,
    amountIn: ONE_ETHER,
    slippage: "100",
  };

  const makeRouteResponse = (
    data: string,
    overrides?: { to?: string; value?: string }
  ): EnsoRouteResponse => ({
    tx: {
      to: overrides?.to ?? ENSO_ROUTER_V2,
      data,
      value: overrides?.value ?? "0",
    },
    gas: "100000",
    amountOut: "1000000",
    minAmountOut: "990000",
    route: [],
  });

  const makeRouteSingle = (token: string = TOKENS.CVX, amount = ONE_ETHER) => encodeFunctionData({
    abi: ENSO_ROUTER_ENTRYPOINT_ABI,
    functionName: "routeSingle",
    args: [{ tokenType: 1, data: encodeTokenAmount(token, amount) }, "0x1234"],
  });

  it("binds the exact ERC20 input, final token, owner, and quoted minimum", () => {
    const protectedResponse = protectEnsoIntentResponse(
      swapRequest,
      makeRouteResponse(makeRouteSingle())
    );
    const decoded = decodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      data: protectedResponse.tx.data as `0x${string}`,
    });

    expect(decoded.functionName).toBe("safeRouteSingle");
    if (decoded.functionName !== "safeRouteSingle") throw new Error("unexpected selector");
    const [tokenIn, tokenOut, receiver, innerData] = decoded.args;
    expect(receiver.toLowerCase()).toBe(USER.toLowerCase());
    expect(innerData).toBe("0x1234");
    expect(decodeAbiParameters(TOKEN_AMOUNT_PARAMETERS, tokenIn.data)).toEqual([
      TOKENS.CVX,
      BigInt(ONE_ETHER),
    ]);
    expect(decodeAbiParameters(TOKEN_AMOUNT_PARAMETERS, tokenOut.data)).toEqual([
      TOKENS.CVXCRV,
      990000n,
    ]);
    expect(() => assertProtectedEnsoIntentResponse(swapRequest, protectedResponse)).not.toThrow();
  });

  it("never accepts an upstream minimum below the requested slippage floor", () => {
    const protectedResponse = protectEnsoIntentResponse(swapRequest, {
      ...makeRouteResponse(makeRouteSingle()),
      minAmountOut: "1",
    });
    expect(protectedResponse.minAmountOut).toBe("990000");
    expect(() => assertProtectedEnsoIntentResponse(swapRequest, protectedResponse)).not.toThrow();
  });

  it("rejects an Enso response that pulls a different token or amount", () => {
    expect(() => protectEnsoIntentResponse(
      swapRequest,
      makeRouteResponse(makeRouteSingle(TOKENS.CVGCVX))
    )).toThrow("input token or amount does not match");

    expect(() => protectEnsoIntentResponse(
      swapRequest,
      makeRouteResponse(makeRouteSingle(TOKENS.CVX, "2"))
    )).toThrow("input token or amount does not match");
  });

  it("rejects extra routeMulti pulls from the wallet", () => {
    const multiRequest = {
      intent: "specialTokenToExternalVault" as const,
      fromAddress: USER,
      receiver: USER,
      inputToken: TOKENS.PXCVX,
      outputVault: LLAMA_AIRFORCE.UCVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    };
    const data = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "routeMulti",
      args: [[
        { tokenType: 1, data: encodeTokenAmount(TOKENS.PXCVX) },
        { tokenType: 1, data: encodeTokenAmount(TOKENS.CVXCRV, "1") },
      ], "0x1234"],
    });
    expect(() => protectEnsoIntentResponse(multiRequest, {
      tx: { to: ENSO_ROUTER_V2, data, value: "0", from: USER },
      gas: "100000",
      amountsOut: { [LLAMA_AIRFORCE.UCVX]: "1000000" },
      minAmountsOut: { [LLAMA_AIRFORCE.UCVX]: "990000" },
      route: [],
    }))
      .toThrow("exactly one bound input token");
  });

  it("rejects Router V1 even when its calldata is otherwise allowed", () => {
    expect(() => protectEnsoIntentResponse(
      swapRequest,
      makeRouteResponse(makeRouteSingle(), { to: ENSO_ROUTER_V1 })
    )).toThrow("unexpected transaction target");
  });

  it("rejects a protected response if its receiver or output binding is changed", () => {
    const protectedResponse = protectEnsoIntentResponse(
      swapRequest,
      makeRouteResponse(makeRouteSingle())
    );
    const decoded = decodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      data: protectedResponse.tx.data as `0x${string}`,
    });
    if (decoded.functionName !== "safeRouteSingle") throw new Error("unexpected selector");
    const [tokenIn, tokenOut, , innerData] = decoded.args;
    const wrongReceiverData = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "safeRouteSingle",
      args: [tokenIn, tokenOut, OTHER, innerData],
    });
    expect(() => assertProtectedEnsoIntentResponse(swapRequest, {
      ...protectedResponse,
      tx: { ...protectedResponse.tx, data: wrongReceiverData },
    })).toThrow("receiver does not match");

    const wrongOutput = {
      tokenType: 1,
      data: encodeTokenAmount(TOKENS.CVGCVX, "990000"),
    };
    const wrongOutputData = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "safeRouteSingle",
      args: [tokenIn, wrongOutput, USER, innerData],
    });
    expect(() => assertProtectedEnsoIntentResponse(swapRequest, {
      ...protectedResponse,
      tx: { ...protectedResponse.tx, data: wrongOutputData },
    })).toThrow("output token or minimum does not match");
  });

  it("binds native input to the exact transaction value", () => {
    const nativeRequest = {
      ...swapRequest,
      tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    };
    const rawData = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "routeSingle",
      args: [{ tokenType: 0, data: "0x" }, "0x1234"],
    });
    const protectedResponse = protectEnsoIntentResponse(
      nativeRequest,
      makeRouteResponse(rawData, { value: ONE_ETHER })
    );
    expect(() => assertProtectedEnsoIntentResponse(nativeRequest, protectedResponse)).not.toThrow();
    expect(() => protectEnsoIntentResponse(
      nativeRequest,
      makeRouteResponse(rawData, { value: "1" })
    )).toThrow("native value does not match amountIn");

    const encodedNativeAmount = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "routeSingle",
      args: [{ tokenType: 0, data: encodeAbiParameters(NATIVE_AMOUNT_PARAMETERS, [BigInt(ONE_ETHER)]) }, "0x1234"],
    });
    expect(() => protectEnsoIntentResponse(
      nativeRequest,
      makeRouteResponse(encodedNativeAmount, { value: ONE_ETHER })
    )).not.toThrow();

    const wrongEncodedNativeAmount = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "routeSingle",
      args: [{ tokenType: 0, data: encodeAbiParameters(NATIVE_AMOUNT_PARAMETERS, [1n]) }, "0x1234"],
    });
    expect(() => protectEnsoIntentResponse(
      nativeRequest,
      makeRouteResponse(wrongEncodedNativeAmount, { value: ONE_ETHER })
    )).toThrow("native input amount does not match amountIn");
  });

  it("locks legacy MORPHO permits to fixed adapter calls and a protected nested route", () => {
    const request = {
      intent: "legacyMorphoWrap" as const,
      fromAddress: USER,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
      slippage: "100",
    };
    const call = (to: string, data: string) => ({
      to,
      data,
      value: "0",
      skipRevert: false,
      callbackHash: ZERO_CALLBACK_HASH,
    });
    const nestedRawRoute = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "routeMulti",
      args: [[], "0x1234"],
    });
    const response = {
      tx: { to: MORPHO_BUNDLER3, data: "0x", value: "0", from: USER },
      gas: "100000",
      amountsOut: { [TOKENS.CVX]: "1000000" },
      minAmountsOut: { [TOKENS.CVX]: "990000" },
      route: [],
      legacyMorphoPermit: {
        token: LEGACY_MORPHO,
        spender: MORPHO_GENERAL_ADAPTER1,
        amount: ONE_ETHER,
        postPermitCalls: [
          call(MORPHO_GENERAL_ADAPTER1, encodeFunctionData({
            abi: MORPHO_ADAPTER_ABI,
            functionName: "erc20TransferFrom",
            args: [LEGACY_MORPHO, MORPHO_GENERAL_ADAPTER1, BigInt(ONE_ETHER)],
          })),
          call(MORPHO_GENERAL_ADAPTER1, encodeFunctionData({
            abi: MORPHO_ADAPTER_ABI,
            functionName: "morphoWrapperDepositFor",
            args: [ENSO_SHORTCUTS, BigInt(ONE_ETHER)],
          })),
          call(ENSO_ROUTER_V2, nestedRawRoute),
        ],
      },
    };

    const protectedResponse = protectEnsoIntentResponse(request, response);
    const nestedData = protectedResponse.legacyMorphoPermit?.postPermitCalls[2]?.data;
    if (!nestedData) throw new Error("missing nested route");
    expect(decodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      data: nestedData as `0x${string}`,
    }).functionName).toBe("safeRouteMulti");
    expect(() => assertProtectedEnsoIntentResponse(request, protectedResponse)).not.toThrow();

    expect(() => protectEnsoIntentResponse(request, {
      ...response,
      legacyMorphoPermit: {
        ...response.legacyMorphoPermit,
        postPermitCalls: [
          ...response.legacyMorphoPermit.postPermitCalls,
          call(OTHER, "0x1234"),
        ],
      },
    })).toThrow("unexpected post-permit calls");
  });

  it("uses a safe multi wrapper with no token-output claim for repayment state changes", () => {
    const repayRequest = {
      intent: "curveLendingRepay" as const,
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YCVXCRV,
      amountIn: ONE_ETHER,
    };
    const rawData = encodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      functionName: "routeSingle",
      args: [{ tokenType: 1, data: encodeTokenAmount(CRVUSD_ADDRESS) }, "0x1234"],
    });
    const protectedResponse = protectEnsoIntentResponse(repayRequest, {
      tx: { to: ENSO_ROUTER_V2, data: rawData, value: "0", from: USER },
      gas: "100000",
      amountsOut: {},
      route: [],
    });
    const decoded = decodeFunctionData({
      abi: ENSO_ROUTER_ENTRYPOINT_ABI,
      data: protectedResponse.tx.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("safeRouteMulti");
    if (decoded.functionName !== "safeRouteMulti") throw new Error("unexpected selector");
    expect(decoded.args[1]).toEqual([]);
    expect(() => assertProtectedEnsoIntentResponse(repayRequest, protectedResponse)).not.toThrow();
  });
});
