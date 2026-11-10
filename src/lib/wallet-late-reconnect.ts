import type { Config, Connector } from "wagmi";
import { reconnect as wagmiReconnect, watchConnectors as wagmiWatchConnectors } from "wagmi/actions";
import { parsePersistedConnectorId } from "@/lib/wallet-connection-guard";

type Status = Config["state"]["status"];

type Deps = {
  reconnect: (config: Config, parameters: { connectors: Connector[] }) => Promise<readonly unknown[]>;
  watchConnectors: (config: Config, parameters: { onChange: () => void }) => () => void;
  subscribeStatus: (config: Config, listener: (status: Status, previous: Status) => void) => () => void;
  getRecentConnectorId: () => string | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
};

/** Delays after load at which to retry if the wallet is still not restored. */
export const LATE_RECONNECT_DELAYS_MS = [1_000, 3_000, 6_000, 10_000] as const;

/**
 * If wagmi's own mount reconnect is never seen to finish (it normally runs in
 * well under a second), start acting anyway after this long.
 */
export const MOUNT_RECONNECT_FALLBACK_MS = 3_000;

/**
 * Wagmi reconnects once on mount, using only the connectors registered at that
 * moment. EIP-6963 wallets (e.g. Frame, `sh.frame`) register when the extension
 * announces itself, which can land after that attempt; wagmi then saves an
 * empty, disconnected state and never retries, so the next page shows
 * "Connect" too. Seen on yldfi.co on 10 Nov 2026: same-tab loads of /zap wiped
 * the stored Frame connection while eth_accounts still returned the account.
 *
 * Once wagmi's mount reconnect has finished (status leaves connecting /
 * reconnecting) and left us disconnected, retry `reconnect` with just the
 * last-used connector when it appears and a few times shortly after load,
 * until connected. Waiting for wagmi first matters: reconnect() has a
 * module-level "already reconnecting" lock, and a single-connector attempt
 * that took it first would stop wagmi restoring a different authorised wallet.
 *
 * This revives nothing wagmi's own reconnect wouldn't: both go through the
 * connector's isAuthorized(). Injected wallets set `wagmi.<id>.disconnected`
 * on a deliberate Disconnect; WalletConnect-style wallets clear their session.
 */
export function installLateReconnect(
  config: Config,
  deps: Partial<Deps> = {},
): () => void {
  if (typeof window === "undefined" && !deps.getRecentConnectorId) return () => undefined;

  const d: Deps = {
    reconnect: wagmiReconnect as Deps["reconnect"],
    watchConnectors: wagmiWatchConnectors as Deps["watchConnectors"],
    subscribeStatus: (cfg, listener) => cfg.subscribe((state) => state.status, listener),
    getRecentConnectorId: () =>
      parsePersistedConnectorId(window.localStorage.getItem("wagmi.recentConnectorId")),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    now: () => Date.now(),
    ...deps,
  };

  const startedAt = d.now();
  let stopped = false;
  let inFlight = false;
  let mountReconnectSettled = false;

  const attempt = async () => {
    if (stopped || inFlight) return;
    if (!mountReconnectSettled && d.now() - startedAt < MOUNT_RECONNECT_FALLBACK_MS) return;
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

  const unsubscribeStatus = d.subscribeStatus(config, (status, previous) => {
    if (status === "connected") return stop();
    if ((previous === "connecting" || previous === "reconnecting") && status === "disconnected") {
      mountReconnectSettled = true;
      void attempt();
    }
  });
  const unwatch = d.watchConnectors(config, { onChange: () => void attempt() });
  const timers = LATE_RECONNECT_DELAYS_MS.map((ms) => d.setTimeout(() => void attempt(), ms));

  function stop() {
    if (stopped) return;
    stopped = true;
    unwatch();
    unsubscribeStatus();
    for (const t of timers) d.clearTimeout(t);
  }

  return stop;
}
