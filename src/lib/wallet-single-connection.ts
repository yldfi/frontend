import type { Config, Connector } from "wagmi";

type Deps = {
  defer: (fn: () => void) => void;
};

/**
 * Keep exactly one wallet connected.
 *
 * Wagmi supports several simultaneous connections: connecting a second wallet
 * (e.g. a Safe over WalletConnect while Frame is connected) adds a connection
 * and makes it current, and disconnecting it falls back to the first one. So a
 * user who "disconnected" was silently still connected with another wallet.
 * Reported 10 Nov 2026; supersedes tracker item 42.
 *
 * Whenever the state is connected with more than one connection, drop every
 * connection except the current one. Runs after the active-connector guard
 * (installed first), which reverts unsolicited injected takeovers
 * synchronously, and is deferred a microtask so that update settles first.
 *
 * Deliberately not wagmi's `disconnect` action (Fable review of #198):
 * - it throws before removing the connection when the wallet's disconnect
 *   fails (WalletConnect relay errors), and nothing would retry, leaving two;
 * - it snapshots `connections` before awaiting the wallet and writes that back
 *   afterwards, losing any change to the current wallet in between.
 * Instead: ask the wallet to disconnect (best effort), detach wagmi's listeners
 * like the action does, and always remove the uid from the latest state.
 * If the dropped connector shares its provider with the current one (RainbowKit
 * reuses one WalletConnect provider across several wallet tiles), skip the
 * wallet-side disconnect: it would end the session the current wallet uses.
 */
export function installSingleConnectionPolicy(
  config: Config,
  deps: Partial<Deps> = {},
): () => void {
  if (typeof window === "undefined" && !deps.defer) return () => undefined;
  const d: Deps = { defer: (fn) => queueMicrotask(fn), ...deps };

  const pending = new Set<string>();

  const drop = async (uid: string, connector: Connector, currentConnector: Connector | undefined) => {
    try {
      const [provider, currentProvider] = await Promise.all([
        connector.getProvider().catch(() => undefined),
        currentConnector?.getProvider().catch(() => undefined),
      ]);
      const sharesProvider = provider !== undefined && provider === currentProvider;
      if (!sharesProvider) await connector.disconnect();
    } catch {
      // Best effort: the connection is removed from state regardless.
    } finally {
      connector.emitter.off("change", config._internal.events.change);
      connector.emitter.off("disconnect", config._internal.events.disconnect);
      connector.emitter.on("connect", config._internal.events.connect);
      config.setState((x) => {
        if (x.current === uid || !x.connections.has(uid)) return x;
        const connections = new Map(x.connections);
        connections.delete(uid);
        return { ...x, connections };
      });
      pending.delete(uid);
    }
  };

  const enforce = () => {
    const { status, current, connections } = config.state;
    if (status !== "connected" || !current || connections.size <= 1) return;
    const currentConnector = connections.get(current)?.connector;
    for (const [uid, connection] of connections) {
      if (uid === current || pending.has(uid)) continue;
      pending.add(uid);
      void drop(uid, connection.connector, currentConnector);
    }
  };

  return config.subscribe(
    (state) => [state.status, state.current, state.connections.size] as const,
    () => d.defer(enforce),
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
  );
}
