import type { Config, Connector } from "wagmi";
import { reconnect as wagmiReconnect, watchConnectors as wagmiWatchConnectors } from "wagmi/actions";
import { parsePersistedConnectorId } from "@/lib/wallet-connection-guard";

type Deps = {
  reconnect: (config: Config, parameters: { connectors: Connector[] }) => Promise<readonly unknown[]>;
  watchConnectors: (config: Config, parameters: { onChange: () => void }) => () => void;
  getRecentConnectorId: () => string | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

/** Delays after load at which to retry if the wallet is still not restored. */
export const LATE_RECONNECT_DELAYS_MS = [1_000, 3_000, 6_000, 10_000] as const;

/**
 * Wagmi reconnects once on mount, using only the connectors registered at that
 * moment. EIP-6963 wallets (e.g. Frame, `sh.frame`) register when the extension
 * announces itself, which can land after that attempt; wagmi then saves an
 * empty, disconnected state and never retries, so the next page shows
 * "Connect" too. Seen on yldfi.co on 10 Nov 2026: same-tab loads of /zap wiped
 * the stored Frame connection while eth_accounts still returned the account.
 *
 * Retry `reconnect` with just the last-used connector when it appears, and a
 * few times shortly after load, until connected. A deliberate Disconnect sets
 * `wagmi.<id>.disconnected`, which makes `isAuthorized()` false, so this never
 * reconnects a wallet the user disconnected.
 */
export function installLateReconnect(
  config: Config,
  deps: Partial<Deps> = {},
): () => void {
  if (typeof window === "undefined" && !deps.getRecentConnectorId) return () => undefined;

  const d: Deps = {
    reconnect: wagmiReconnect as Deps["reconnect"],
    watchConnectors: wagmiWatchConnectors as Deps["watchConnectors"],
    getRecentConnectorId: () =>
      parsePersistedConnectorId(window.localStorage.getItem("wagmi.recentConnectorId")),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    ...deps,
  };

  let stopped = false;
  let inFlight = false;

  const attempt = async () => {
    if (stopped || inFlight) return;
    const { status } = config.state;
    if (status === "connected") return stop();
    if (status === "connecting" || status === "reconnecting") return;

    const recentId = d.getRecentConnectorId();
    if (!recentId) return;
    const connector = config.connectors.find((c) => c.id === recentId);
    if (!connector) return;

    inFlight = true;
    try {
      const connections = await d.reconnect(config, { connectors: [connector] });
      if (connections.length > 0) stop();
    } catch {
      // A later trigger retries.
    } finally {
      inFlight = false;
    }
  };

  const unwatch = d.watchConnectors(config, { onChange: () => void attempt() });
  const timers = LATE_RECONNECT_DELAYS_MS.map((ms) => d.setTimeout(() => void attempt(), ms));

  function stop() {
    if (stopped) return;
    stopped = true;
    unwatch();
    for (const t of timers) d.clearTimeout(t);
  }

  return stop;
}
