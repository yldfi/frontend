import type { Config, State } from "wagmi";

type ConnectorSelection = {
  currentConnectorId?: string;
  previousConnectorId?: string;
  recentConnectorId?: string | null;
  status: State["status"];
};

export function parsePersistedConnectorId(value: string | null): string | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return value;
  }
}

export function shouldRejectConnectorTakeover({
  currentConnectorId,
  previousConnectorId,
  recentConnectorId,
  status,
}: ConnectorSelection): boolean {
  if (status === "connecting" || status === "reconnecting") return false;
  if (!currentConnectorId || !previousConnectorId || !recentConnectorId) return false;

  return currentConnectorId !== recentConnectorId
    && previousConnectorId === recentConnectorId;
}

/**
 * EIP-6963 injected wallets can emit `connect`/`accountsChanged` while another
 * connector is active. Wagmi treats that event as a new current connection,
 * even though the user did not select a different wallet in the app.
 *
 * Explicit Wagmi connects update `wagmi.recentConnectorId` before changing the
 * current connection, so preserving that persisted selection filters only
 * unsolicited provider takeovers and still allows intentional wallet changes.
 */
export function installActiveConnectorGuard(config: Config): () => void {
  if (typeof window === "undefined") return () => undefined;

  return config.subscribe(
    (state) => state.current,
    (current, previousCurrent) => {
      if (!current || !previousCurrent || current === previousCurrent) return;

      const state = config.state;
      const currentConnection = state.connections.get(current);
      const previousConnection = state.connections.get(previousCurrent);
      const recentConnectorId = parsePersistedConnectorId(
        window.localStorage.getItem("wagmi.recentConnectorId"),
      );

      if (!shouldRejectConnectorTakeover({
        currentConnectorId: currentConnection?.connector.id,
        previousConnectorId: previousConnection?.connector.id,
        recentConnectorId,
        status: state.status,
      })) return;

      config.setState((latestState) => {
        if (latestState.current !== current) return latestState;

        const connections = new Map(latestState.connections);
        connections.delete(current);

        return {
          ...latestState,
          connections,
          current: previousCurrent,
        };
      });
    },
  );
}
