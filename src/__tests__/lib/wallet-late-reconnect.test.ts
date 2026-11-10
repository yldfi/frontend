// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// The global setup mocks wagmi; this file needs the real reconnect machinery.
vi.unmock("wagmi");
vi.unmock("wagmi/actions");
import { createConfig, createConnector, http } from "wagmi";
import { reconnect } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import type { Config, Connector } from "wagmi";
import {
  LATE_RECONNECT_DELAYS_MS,
  MOUNT_RECONNECT_FALLBACK_MS,
  installLateReconnect,
} from "@/lib/wallet-late-reconnect";

type Status = "connected" | "connecting" | "reconnecting" | "disconnected";

function harness(opts: { status?: Status; connectors?: string[]; recent?: string | null } = {}) {
  const state = { status: opts.status ?? ("disconnected" as Status) };
  const connectors: Connector[] = (opts.connectors ?? []).map((id) => ({ id } as Connector));
  const config = {
    get state() { return state; },
    get connectors() { return connectors; },
  } as unknown as Config;

  let clock = 0;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let onConnectorsChange: (() => void) | null = null;
  let onStatus: ((s: Status, p: Status) => void) | null = null;
  const unwatch = vi.fn();
  const unsubscribe = vi.fn();
  const reconnectFn = vi.fn(async () => [] as unknown[]);

  installLateReconnect(config, {
    reconnect: reconnectFn,
    watchConnectors: (_config: Config, { onChange }: { onChange: () => void }) => { onConnectorsChange = onChange; return unwatch; },
    subscribeStatus: (_config: Config, listener: (s: Status, p: Status) => void) => { onStatus = listener; return unsubscribe; },
    getRecentConnectorId: () => (opts.recent === undefined ? "sh.frame" : opts.recent),
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
    now: () => clock,
  });

  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  return {
    state, reconnect: reconnectFn, unwatch, unsubscribe, timers, flush,
    setClock: (ms: number) => { clock = ms; },
    /** wagmi's mount reconnect: status goes reconnecting -> disconnected. */
    mountReconnectFinished: async () => {
      state.status = "reconnecting"; onStatus?.("reconnecting", "disconnected");
      state.status = "disconnected"; onStatus?.("disconnected", "reconnecting");
      await flush();
    },
    announce: async (id: string) => { connectors.push({ id } as Connector); onConnectorsChange?.(); await flush(); },
    fire: async (i: number) => { clock = timers[i].ms; timers[i].fn(); await flush(); },
  };
}

describe("installLateReconnect", () => {
  it("schedules retries at 1 s, 3 s, 6 s and 10 s", () => {
    const h = harness();
    expect(h.timers.map((t) => t.ms)).toEqual([...LATE_RECONNECT_DELAYS_MS]);
  });

  it("does not act before wagmi's own mount reconnect has finished", async () => {
    const h = harness({ connectors: ["sh.frame"] });
    await h.announce("io.rabby"); // wagmi's connectors.setState fires the watcher first
    await h.fire(0); // 1 s, still no settle seen
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("reconnects the last-used wallet once wagmi gave up", async () => {
    const h = harness({ connectors: ["io.metamask"] });
    await h.mountReconnectFinished(); // Frame not registered yet -> wagmi ends disconnected
    expect(h.reconnect).not.toHaveBeenCalled();
    h.reconnect.mockResolvedValueOnce([{}]);
    await h.announce("sh.frame");
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    const [, params] = h.reconnect.mock.calls[0] as unknown as [Config, { connectors: Connector[] }];
    expect(params.connectors.map((c) => c.id)).toEqual(["sh.frame"]);
    expect(h.unwatch).toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalled();
    expect(h.timers.every((t) => t.cleared)).toBe(true);
  });

  it("retries on the timers while the wallet is present but not yet authorised", async () => {
    const h = harness({ connectors: ["sh.frame"] });
    await h.mountReconnectFinished(); // attempt #1 (isAuthorized false -> [])
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    h.reconnect.mockResolvedValueOnce([{}]);
    await h.fire(1);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    expect(h.timers.slice(2).every((t) => t.cleared)).toBe(true);
  });

  it("falls back to acting after 3 s if the mount reconnect was never seen", async () => {
    const h = harness({ connectors: ["sh.frame"] });
    await h.fire(0);
    expect(h.reconnect).not.toHaveBeenCalled();
    h.setClock(MOUNT_RECONNECT_FALLBACK_MS);
    await h.fire(1);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });

  it("stops once connected", async () => {
    const h = harness({ status: "connected", connectors: ["sh.frame"] });
    await h.fire(2);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.unwatch).toHaveBeenCalled();
  });

  it("does nothing without a last-used wallet, or when another wallet announces", async () => {
    const h = harness({ recent: null, connectors: ["sh.frame"] });
    await h.mountReconnectFinished();
    await h.announce("io.rabby");
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});

// Real @wagmi/core: the review's scenario. The last-used wallet is no longer
// authorised but another is; wagmi's own mount reconnect must still restore the
// other one with the watcher installed (reconnect() has a module-level lock).
function fakeConnector(id: string, authorized: boolean) {
  return createConnector(() => ({
    id,
    name: id,
    type: "fake",
    async setup() {},
    async connect() {
      return { accounts: ["0x00000000000000000000000000000000000000a1"] as const, chainId: 1 } as never;
    },
    async disconnect() {},
    async getAccounts() { return ["0x00000000000000000000000000000000000000a1"] as const; },
    async getChainId() { return 1; },
    async getProvider() { return { id }; },
    async isAuthorized() { return authorized; },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }));
}

describe("installLateReconnect with real @wagmi/core", () => {
  it("lets wagmi's mount reconnect restore another authorised wallet", async () => {
    const config = createConfig({
      chains: [mainnet],
      connectors: [fakeConnector("recent.wallet", false), fakeConnector("other.wallet", true)],
      transports: { [mainnet.id]: http() },
      storage: null,
      multiInjectedProviderDiscovery: false,
    });
    const stop = installLateReconnect(config, {
      getRecentConnectorId: () => "recent.wallet",
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });

    // What wagmi's hydrate onMount does: replace the connector list, then reconnect.
    config._internal.connectors.setState((x: readonly Connector[]) => [...x]);
    await reconnect(config);

    expect(config.state.status).toBe("connected");
    expect(config.state.connections.get(config.state.current!)?.connector.id).toBe("other.wallet");
    stop();
  });
});
