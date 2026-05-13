import { describe, expect, it } from "vitest";
import {
  assertEnsoIntentTxTarget,
  assertValidEnsoIntentRequest,
  getIntentVault,
  getYldVaultToVaultIntentName,
  isStandardYldVaultIntentVault,
  shouldUsePlainTokenSwapIntent,
} from "@/lib/enso-intents";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";

const USER = "0xa88e98bBD2Af6DDD642407cB5455f956f0C553F0";
const OTHER = "0x66215D23B8A247C80c2D1B7beF4BefC2AB384bCE";
const ONE_ETHER = "1000000000000000000";

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
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "cvgCvxZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "pxCvxZapIn",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      inputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "pxCvxZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).not.toThrow();
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
    })).toThrow("cvgCVX-backed");

    expect(() => assertValidEnsoIntentRequest({
      intent: "pxCvxZapOut",
      fromAddress: USER,
      vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
      outputToken: TOKENS.CVX,
      amountIn: ONE_ETHER,
    })).toThrow("pxCVX-backed");
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
    })).not.toThrow();

    expect(() => assertValidEnsoIntentRequest({
      intent: "yldVaultToCvgCvxVault",
      fromAddress: USER,
      sourceVault: VAULT_ADDRESSES.YCVXCRV,
      targetVault: VAULT_ADDRESSES.YSPXCVX,
      amountIn: ONE_ETHER,
    })).toThrow("does not match");
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

  it("allows only Enso router transaction targets in intent responses", () => {
    expect(() => assertEnsoIntentTxTarget({
      tx: {
        to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
        data: "0x",
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).not.toThrow();

    expect(() => assertEnsoIntentTxTarget({
      tx: {
        to: "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003",
        data: "0x",
        value: "0",
      },
      gas: "1",
      amountOut: "1",
      route: [],
    })).toThrow("ENSO_SHORTCUTS");

    expect(() => assertEnsoIntentTxTarget({
      tx: {
        to: OTHER,
        data: "0x",
        value: "0",
        from: USER,
      },
      gas: "1",
      amountsOut: {},
    })).toThrow("unexpected transaction target");
  });
});
