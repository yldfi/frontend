// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// The global setup mocks wagmi; this file needs the real connection machinery.
vi.unmock("wagmi");
vi.unmock("wagmi/actions");

import { createConfig, createConnector, http } from "wagmi";
import type { Connector } from "wagmi";
import { connect, disconnect, reconnect } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { installSingleConnectionPolicy } from "@/lib/wallet-single-connection";

function fakeWallet(id: string, account: `0x${string}`, opts: { authorized?: boolean } = {}) {
  const disconnected = vi.fn();
  const factory = createConnector(() => ({
    id,
    name: id,
    type: "fake",
    async setup() {},
    async connect() { return { accounts: [account] as const, chainId: 1 } as never; },
    async disconnect() { disconnected(); },
    async getAccounts() { return [account] as const; },
    async getChainId() { return 1; },
    async getProvider() { return { id }; },
    async isAuthorized() { return opts.authorized ?? true; },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }));
  return { factory, disconnected };
}

const FRAME = "0x00000000000000000000000000000000000000f1" as const;
const SAFE = "0x00000000000000000000000000000000000000s5".replace("s", "a") as `0x${string}`;
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function setup() {
  const frame = fakeWallet("sh.frame", FRAME);
  const safe = fakeWallet("walletConnect", SAFE);
  const config = createConfig({
    chains: [mainnet],
    connectors: [frame.factory, safe.factory],
    transports: { [mainnet.id]: http() },
    storage: null,
    multiInjectedProviderDiscovery: false,
  });
  // Node env has no window: pass the scheduler so the policy installs.
  const stop = installSingleConnectionPolicy(config, { defer: (fn) => queueMicrotask(fn) });
  const byId = (id: string) => config.connectors.find((c: Connector) => c.id === id)!;
  return { config, frame, safe, stop, byId };
}

describe("single wallet connection", () => {
  it("connecting the Safe over Frame disconnects Frame; disconnecting the Safe leaves nothing connected", async () => {
    const { config, frame, byId, stop } = setup();

    await connect(config, { connector: byId("sh.frame") } as never);
    await settle();
    expect(config.state.connections.size).toBe(1);

    await connect(config, { connector: byId("walletConnect") } as never);
    await settle();
    expect(config.state.connections.size).toBe(1);
    expect(config.state.connections.get(config.state.current!)?.connector.id).toBe("walletConnect");
    expect(frame.disconnected).toHaveBeenCalledTimes(1);

    await disconnect(config);
    await settle();
    expect(config.state.status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
    stop();
  });

  it("keeps only the current wallet when a page load restores two", async () => {
    const { config, safe, stop } = setup();
    await reconnect(config); // both fake wallets are authorised
    await settle();
    expect(config.state.status).toBe("connected");
    expect(config.state.connections.size).toBe(1);
    expect(config.state.connections.get(config.state.current!)?.connector.id).toBe("sh.frame");
    expect(safe.disconnected).toHaveBeenCalledTimes(1);
    stop();
  });

  it("leaves a single connection alone", async () => {
    const { config, frame, byId, stop } = setup();
    await connect(config, { connector: byId("sh.frame") } as never);
    await settle();
    expect(config.state.connections.size).toBe(1);
    expect(frame.disconnected).not.toHaveBeenCalled();
    stop();
  });
});
