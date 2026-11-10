import { describe, it, expect, vi } from "vitest";
import type { Config, Connector } from "wagmi";
import { LATE_RECONNECT_DELAYS_MS, installLateReconnect } from "@/lib/wallet-late-reconnect";

type Status = "connected" | "connecting" | "reconnecting" | "disconnected";

function harness(opts: { status?: Status; connectors?: string[]; recent?: string | null } = {}) {
  const state = { status: opts.status ?? "disconnected" as Status };
  const connectors: Connector[] = (opts.connectors ?? []).map((id) => ({ id } as Connector));
  const config = {
    get state() { return state; },
    get connectors() { return connectors; },
  } as unknown as Config;

  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let onConnectorsChange: (() => void) | null = null;
  const unwatch = vi.fn();
  const reconnect = vi.fn(async () => [] as unknown[]);

  const stop = installLateReconnect(config, {
    reconnect,
    watchConnectors: (_c, { onChange }) => { onConnectorsChange = onChange; return unwatch; },
    getRecentConnectorId: () => (opts.recent === undefined ? "sh.frame" : opts.recent),
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { (t as { cleared: boolean }).cleared = true; },
  });

  return {
    state, connectors, reconnect, unwatch, timers, stop,
    announce: (id: string) => { connectors.push({ id } as Connector); onConnectorsChange?.(); },
    fire: async (i: number) => { timers[i].fn(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe("installLateReconnect", () => {
  it("schedules retries at 1 s, 3 s, 6 s and 10 s", () => {
    const h = harness();
    expect(h.timers.map((t) => t.ms)).toEqual([...LATE_RECONNECT_DELAYS_MS]);
  });

  it("reconnects with the last-used connector once it announces after wagmi gave up", async () => {
    const h = harness({ connectors: ["io.metamask", "walletConnect"] });
    expect(h.reconnect).not.toHaveBeenCalled();
    h.reconnect.mockResolvedValueOnce([{}]);
    h.announce("sh.frame");
    await Promise.resolve();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    const [, params] = h.reconnect.mock.calls[0] as unknown as [Config, { connectors: Connector[] }];
    expect(params.connectors.map((c) => c.id)).toEqual(["sh.frame"]);
    await Promise.resolve();
    expect(h.unwatch).toHaveBeenCalled();
    expect(h.timers.every((t) => t.cleared)).toBe(true);
  });

  it("retries on the timers while the wallet is present but not yet authorised", async () => {
    const h = harness({ connectors: ["sh.frame"] });
    await h.fire(0); // isAuthorized false -> reconnect returns []
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    h.reconnect.mockResolvedValueOnce([{}]);
    await h.fire(1);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    expect(h.timers.slice(2).every((t) => t.cleared)).toBe(true);
  });

  it("does nothing when already connected (and stops)", async () => {
    const h = harness({ status: "connected", connectors: ["sh.frame"] });
    await h.fire(0);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.unwatch).toHaveBeenCalled();
  });

  it("waits while wagmi's own reconnect is in progress", async () => {
    const h = harness({ status: "reconnecting", connectors: ["sh.frame"] });
    await h.fire(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("does nothing without a last-used wallet (never connected)", async () => {
    const h = harness({ recent: null, connectors: ["sh.frame"] });
    await h.fire(0);
    h.announce("io.rabby");
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("ignores other wallets announcing", async () => {
    const h = harness({ connectors: [] });
    h.announce("io.rabby");
    await Promise.resolve();
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
