import type { Config, Connector } from "wagmi";
import { disconnect as wagmiDisconnect } from "wagmi/actions";

type Deps = {
  disconnect: (config: Config, parameters: { connector: Connector }) => Promise<void>;
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
 * Whenever the state is connected with more than one connection, disconnect
 * every connection except the current one. Runs after the active-connector
 * guard (installed first), which reverts unsolicited injected takeovers before
 * this sees them, and is deferred so the guard's state update settles first.
 * Disconnecting an injected wallet this way sets its `.disconnected` shim, so
 * it isn't silently restored on the next load either.
 */
export function installSingleConnectionPolicy(
  config: Config,
  deps: Partial<Deps> = {},
): () => void {
  if (typeof window === "undefined" && !deps.defer) return () => undefined;

  const d: Deps = {
    disconnect: wagmiDisconnect as Deps["disconnect"],
    defer: (fn) => queueMicrotask(fn),
    ...deps,
  };

  const pending = new Set<string>();

  const enforce = () => {
    const { status, current, connections } = config.state;
    if (status !== "connected" || !current || connections.size <= 1) return;
    for (const [uid, connection] of connections) {
      if (uid === current || pending.has(uid)) continue;
      pending.add(uid);
      d.disconnect(config, { connector: connection.connector })
        .catch(() => undefined)
        .finally(() => pending.delete(uid));
    }
  };

  return config.subscribe(
    (state) => [state.status, state.current, state.connections.size] as const,
    () => d.defer(enforce),
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
  );
}
