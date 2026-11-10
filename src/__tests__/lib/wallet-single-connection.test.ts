// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The global setup mocks wagmi; this file needs the real connection machinery.
vi.unmock("wagmi");
vi.unmock("wagmi/actions");

import { createConfig, createConnector, createStorage, http } from "wagmi";
import type { Connector } from "wagmi";
import { connect, disconnect, reconnect } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { installActiveConnectorGuard } from "@/lib/wallet-connection-guard";
import { installSingleConnectionPolicy } from "@/lib/wallet-single-connection";

type FakeOpts = {
  disconnect?: () => Promise<void>;
  provider?: object;
};

function fakeWallet(id: string, account: `0x${string}`, opts: FakeOpts = {}) {
  const disconnected = vi.fn();
  const provider = opts.provider ?? { id };
  const factory = createConnector(() => ({
    id,
    name: id,
    type: "fake",
    async setup() {},
    async connect() { return { accounts: [account] as const, chainId: 1 } as never; },
    async disconnect() { disconnected(); await opts.disconnect?.(); },
    async getAccounts() { return [account] as const; },
    async getChainId() { return 1; },
    async getProvider() { return provider; },
    async isAuthorized() { return true; },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }));
  return { factory, disconnected };
}

const FRAME = "0x00000000000000000000000000000000000000f1" as const;
const SAFE = "0x00000000000000000000000000000000000000a5" as const;
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

// In-memory localStorage, shared by wagmi's storage and the guard (which reads
// window.localStorage directly).
let memory: Map<string, string>;
const memoryStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
};

beforeEach(() => {
  memory = new Map();
  vi.stubGlobal("window", { localStorage: memoryStorage });
});
afterEach(() => vi.unstubAllGlobals());

function setup(frameOpts: FakeOpts = {}, safeOpts: FakeOpts = {}) {
  const frame = fakeWallet("sh.frame", FRAME, frameOpts);
  const safe = fakeWallet("walletConnect", SAFE, safeOpts);
  const config = createConfig({
    chains: [mainnet],
    connectors: [frame.factory, safe.factory],
    transports: { [mainnet.id]: http() },
    storage: createStorage({ storage: memoryStorage }),
    multiInjectedProviderDiscovery: false,
  });
  // Same order as src/config/wagmi.ts.
  const stopGuard = installActiveConnectorGuard(config);
  const stopPolicy = installSingleConnectionPolicy(config, { defer: (fn) => queueMicrotask(fn) });
  const byId = (id: string) => config.connectors.find((c: Connector) => c.id === id)!;
  const currentId = () => config.state.connections.get(config.state.current!)?.connector.id;
  return { config, frame, safe, byId, currentId, stop: () => { stopPolicy(); stopGuard(); } };
}

describe("single wallet connection", () => {
  it("Frame, then Safe -> only Safe; disconnect Safe -> nothing connected", async () => {
    const { config, frame, byId, currentId, stop } = setup();
    await connect(config, { connector: byId("sh.frame") } as never);
    await settle();
    await connect(config, { connector: byId("walletConnect") } as never);
    await settle();
    expect(config.state.connections.size).toBe(1);
    expect(currentId()).toBe("walletConnect");
    expect(frame.disconnected).toHaveBeenCalledTimes(1);

    await disconnect(config);
    await settle();
    expect(config.state.status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
    stop();
  });

  it("still drops the old connection when its wallet-side disconnect fails", async () => {
    const { config, byId, currentId, stop } = setup({}, { disconnect: async () => { throw new Error("relay teardown failed"); } });
    await connect(config, { connector: byId("walletConnect") } as never);
    await settle();
    await connect(config, { connector: byId("sh.frame") } as never);
    await settle();
    expect(config.state.connections.size).toBe(1);
    expect(currentId()).toBe("sh.frame");

    await disconnect(config); // must not fall back to the Safe
    await settle();
    expect(config.state.connections.size).toBe(0);
    stop();
  });

  it("doesn't lose a change on the current wallet while the old one is disconnecting", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const { config, byId, stop } = setup({ disconnect: () => slow });
    await connect(config, { connector: byId("sh.frame") } as never);
    await settle();
    await connect(config, { connector: byId("walletConnect") } as never);
    await settle(); // Frame's disconnect is now pending

    byId("walletConnect").emitter.emit("change", { chainId: 10 });
    release();
    await settle();

    expect(config.state.connections.size).toBe(1);
    expect(config.state.connections.get(config.state.current!)?.chainId).toBe(10);
    stop();
  });

  it("doesn't end a WalletConnect session shared with the current wallet", async () => {
    const sharedProvider = { shared: true };
    const { config, frame, byId, currentId, stop } = setup({ provider: sharedProvider }, { provider: sharedProvider });
    await connect(config, { connector: byId("sh.frame") } as never);
    await settle();
    await connect(config, { connector: byId("walletConnect") } as never);
    await settle();
    expect(config.state.connections.size).toBe(1);
    expect(currentId()).toBe("walletConnect");
    expect(frame.disconnected).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the last-used wallet when a page load restores two", async () => {
    memory.set("wagmi.recentConnectorId", JSON.stringify("walletConnect"));
    const { config, frame, currentId, stop } = setup();
    await reconnect(config);
    await settle();
    expect(config.state.status).toBe("connected");
    expect(config.state.connections.size).toBe(1);
    expect(currentId()).toBe("walletConnect");
    expect(frame.disconnected).toHaveBeenCalledTimes(1);
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
