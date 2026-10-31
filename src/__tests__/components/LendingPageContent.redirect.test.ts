import { describe, expect, it } from "vitest";
import { shouldRedirectFromLending } from "@/components/lending/LendingPageContent";

const deprecatedMarket = {
  vaultFound: true,
  hasController: true,
  lendingDisabledWithoutPosition: true,
  walletSettling: false,
  positionLoading: false,
  positionError: false,
  hasLoan: false,
};

describe("shouldRedirectFromLending", () => {
  it("redirects unknown vaults and vaults without a LlamaLend controller", () => {
    expect(shouldRedirectFromLending({ ...deprecatedMarket, vaultFound: false })).toBe(true);
    expect(shouldRedirectFromLending({ ...deprecatedMarket, hasController: false, hasLoan: true })).toBe(true);
  });

  it("never redirects an open market", () => {
    expect(shouldRedirectFromLending({ ...deprecatedMarket, lendingDisabledWithoutPosition: false })).toBe(false);
  });

  it("keeps existing borrowers on a deprecated market", () => {
    expect(shouldRedirectFromLending({ ...deprecatedMarket, hasLoan: true })).toBe(false);
  });

  it("waits for the wallet to finish reconnecting on a direct page load", () => {
    expect(shouldRedirectFromLending({ ...deprecatedMarket, walletSettling: true })).toBe(false);
  });

  it("waits for the position read, and does not treat a failed read as no loan", () => {
    expect(shouldRedirectFromLending({ ...deprecatedMarket, positionLoading: true })).toBe(false);
    expect(shouldRedirectFromLending({ ...deprecatedMarket, positionError: true })).toBe(false);
  });

  it("redirects once the wallet and position are settled and there is no loan", () => {
    expect(shouldRedirectFromLending(deprecatedMarket)).toBe(true);
  });
});
