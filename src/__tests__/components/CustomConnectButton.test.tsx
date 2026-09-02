import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectButtonContent } from "@/components/CustomConnectButton";
import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";

vi.mock("@/hooks/useIsSafeWallet", () => ({
  useIsSafeWallet: vi.fn(),
}));

const mockUseIsSafeWallet = vi.mocked(useIsSafeWallet);
const account = {
  address: "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f",
  displayName: "yldfi.eth",
};
const handlers = {
  openAccountModal: vi.fn(),
  openConnectModal: vi.fn(),
  onSwitchNetwork: vi.fn(),
};

describe("ConnectButtonContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Safe mark next to a verified Safe account", () => {
    mockUseIsSafeWallet.mockReturnValue(true);

    render(
      <ConnectButtonContent
        account={account}
        chain={{ id: 1 }}
        mounted
        {...handlers}
      />,
    );

    expect(screen.getByRole("img", { name: "Safe wallet" })).toBeDefined();
    expect(screen.getByRole("button", { name: /yldfi\.eth/i })).toBeDefined();
  });

  it("does not label a normal wallet as Safe", () => {
    mockUseIsSafeWallet.mockReturnValue(false);

    render(
      <ConnectButtonContent
        account={account}
        chain={{ id: 1 }}
        mounted
        {...handlers}
      />,
    );

    expect(screen.queryByRole("img", { name: "Safe wallet" })).toBeNull();
  });
});
