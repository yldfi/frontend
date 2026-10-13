import { expect, type Page } from "@playwright/test";

/** Read-only test account (vitalik.eth); the E2E wallet can't sign, so nothing is ever sent. */
export const TEST_WALLET_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
export const TEST_WALLET_NAME = "E2E Wallet";

/**
 * Inject a minimal EIP-1193 wallet, announced over EIP-6963, before the app loads. It only
 * answers account/chain queries, so wagmi treats the test account as connected while chain
 * reads keep going through the app's own RPC transports. Signing and sending are rejected.
 */
export async function injectTestWallet(page: Page, address: string = TEST_WALLET_ADDRESS): Promise<void> {
  await page.addInitScript(
    ({ address, name }) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const provider = {
        async request({ method }: { method: string; params?: unknown[] }): Promise<unknown> {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return "0x1";
            case "net_version":
              return "1";
            case "wallet_switchEthereumChain":
              return null;
            case "wallet_getPermissions":
            case "wallet_requestPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_revokePermissions":
              return null;
            default:
              throw Object.assign(new Error(`${name}: ${method} is not supported`), { code: 4200 });
          }
        },
        on(event: string, fn: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(fn);
          return provider;
        },
        removeListener(event: string, fn: (...args: unknown[]) => void) {
          listeners[event] = (listeners[event] ?? []).filter((l) => l !== fn);
          return provider;
        },
      };
      const detail = Object.freeze({
        info: {
          uuid: "00000000-0000-4000-8000-00000000e2e0",
          name,
          icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E",
          rdns: "fi.yld.e2e",
        },
        provider,
      });
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { address, name: TEST_WALLET_NAME },
  );
}

/**
 * Wait until the app shows the test account as connected. wagmi usually reconnects the announced
 * wallet on its own; otherwise go through the app's normal RainbowKit connect flow.
 */
export async function connectTestWallet(page: Page): Promise<void> {
  const account = page.getByRole("button", { name: /vitalik\.eth|0xd8dA/i }).first();
  // "Connect wallet" shows briefly before wagmi's reconnect finishes, so give the reconnect a
  // chance before falling back to the modal.
  const reconnected = await account.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!reconnected) {
    await page.getByRole("button", { name: /connect wallet/i }).first().click();
    await page.getByRole("button", { name: new RegExp(TEST_WALLET_NAME, "i") }).click();
  }
  await expect(account).toBeVisible({ timeout: 15_000 });
}
