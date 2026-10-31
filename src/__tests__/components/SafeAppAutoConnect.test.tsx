import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccount, useConnect } from "wagmi";

import { SafeAppAutoConnect } from "@/components/SafeAppAutoConnect";

const safeConnector = { id: "safe", name: "Safe" };
const injectedConnector = { id: "io.metamask", name: "MetaMask" };

function setup({ framed, currentId, status = "disconnected" }: { framed: boolean; currentId?: string; status?: string }) {
  const connect = vi.fn();
  vi.mocked(useAccount).mockReturnValue({
    connector: currentId ? { id: currentId } : undefined,
    status,
  } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useConnect).mockReturnValue({
    connect,
    connectors: [injectedConnector, safeConnector],
  } as unknown as ReturnType<typeof useConnect>);
  vi.spyOn(window, "parent", "get").mockReturnValue((framed ? {} : window) as Window);
  return { connect };
}

describe("SafeAppAutoConnect", () => {
  afterEach(() => vi.restoreAllMocks());

  it("connects the Safe connector when opened inside Safe{Wallet}", () => {
    const { connect } = setup({ framed: true });
    render(<SafeAppAutoConnect />);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toEqual({ connector: safeConnector });
  });

  it("replaces an injected wallet that won the reconnect race inside the Safe", () => {
    const { connect } = setup({ framed: true, currentId: "io.metamask", status: "connected" });
    render(<SafeAppAutoConnect />);
    expect(connect.mock.calls[0][0]).toEqual({ connector: safeConnector });
  });

  it("does nothing on the normal site, while reconnecting, or when the Safe is already active", () => {
    for (const args of [
      { framed: false },
      { framed: true, status: "reconnecting" },
      { framed: true, currentId: "safe", status: "connected" },
    ]) {
      const { connect } = setup(args);
      const { unmount } = render(<SafeAppAutoConnect />);
      expect(connect).not.toHaveBeenCalled();
      unmount();
    }
  });
});
