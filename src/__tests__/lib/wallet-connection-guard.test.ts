import type { Config, State } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installActiveConnectorGuard,
  parsePersistedConnectorId,
  shouldRejectConnectorTakeover,
} from "@/lib/wallet-connection-guard";

describe("wallet connection guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.localStorage.getItem).mockReturnValue(null);
  });

  it("parses Wagmi's serialized recent connector ID", () => {
    expect(parsePersistedConnectorId('"walletConnect"')).toBe("walletConnect");
    expect(parsePersistedConnectorId("sh.frame")).toBe("sh.frame");
    expect(parsePersistedConnectorId(null)).toBeNull();
    expect(parsePersistedConnectorId("{}")).toBeNull();
  });

  it("rejects an unsolicited Frame takeover of persisted WalletConnect", () => {
    expect(shouldRejectConnectorTakeover({
      currentConnectorId: "sh.frame",
      previousConnectorId: "walletConnect",
      recentConnectorId: "walletConnect",
      status: "connected",
    })).toBe(true);
  });

  it("allows an intentional connector switch", () => {
    expect(shouldRejectConnectorTakeover({
      currentConnectorId: "sh.frame",
      previousConnectorId: "walletConnect",
      recentConnectorId: "sh.frame",
      status: "connected",
    })).toBe(false);
  });

  it.each(["connecting", "reconnecting"] as const)(
    "allows connector changes while Wagmi is %s",
    (status) => {
      expect(shouldRejectConnectorTakeover({
        currentConnectorId: "sh.frame",
        previousConnectorId: "walletConnect",
        recentConnectorId: "walletConnect",
        status,
      })).toBe(false);
    },
  );

  it("does not guess when there is no persisted selection", () => {
    expect(shouldRejectConnectorTakeover({
      currentConnectorId: "sh.frame",
      previousConnectorId: "walletConnect",
      recentConnectorId: null,
      status: "connected",
    })).toBe(false);
  });

  it("restores WalletConnect and removes an unsolicited Frame connection", () => {
    const walletConnect = {
      accounts: ["0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f"],
      chainId: 1,
      connector: { id: "walletConnect", uid: "wallet-connect" },
    };
    const frame = {
      accounts: ["0x7bdfE11c4981Dd4c33E1aa62457B8773253791b3"],
      chainId: 1,
      connector: { id: "sh.frame", uid: "frame" },
    };
    let state = {
      chainId: 1,
      connections: new Map([["wallet-connect", walletConnect]]),
      current: "wallet-connect",
      status: "connected",
    } as unknown as State;
    let onCurrentChange: ((current: string | null, previous: string | null) => void) | undefined;
    const setState = vi.fn((update: State | ((state: State) => State)) => {
      state = typeof update === "function" ? update(state) : update;
    });
    const config = {
      get state() {
        return state;
      },
      setState,
      subscribe: vi.fn((_selector, listener) => {
        onCurrentChange = listener;
        return vi.fn();
      }),
    } as unknown as Config;

    vi.mocked(window.localStorage.getItem).mockReturnValue('"walletConnect"');
    installActiveConnectorGuard(config);

    state = {
      ...state,
      connections: new Map([
        ["wallet-connect", walletConnect],
        ["frame", frame],
      ]),
      current: "frame",
    } as unknown as State;
    onCurrentChange?.("frame", "wallet-connect");

    expect(setState).toHaveBeenCalledOnce();
    expect(state.current).toBe("wallet-connect");
    expect(state.connections.has("wallet-connect")).toBe(true);
    expect(state.connections.has("frame")).toBe(false);
  });
});
