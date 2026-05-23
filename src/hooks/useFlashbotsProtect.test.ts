import { describe, expect, it } from "vitest";
import { isUnsupportedFlashbotsWallet } from "./useFlashbotsProtect";

describe("isUnsupportedFlashbotsWallet", () => {
  it("treats Rabby connector names as unsupported", () => {
    expect(isUnsupportedFlashbotsWallet({ connectorName: "Rabby Wallet" })).toBe(true);
  });

  it("detects Rabby when it is exposed through a generic injected connector", () => {
    expect(isUnsupportedFlashbotsWallet({
      connectorName: "Injected",
      connectorId: "injected",
      ethereumProvider: { isRabby: true },
    })).toBe(true);
  });

  it("keeps regular injected wallets eligible for Flashbots signing", () => {
    expect(isUnsupportedFlashbotsWallet({
      connectorName: "MetaMask",
      connectorId: "io.metamask",
      ethereumProvider: {},
    })).toBe(false);
  });
});
