"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSwitchChain } from "wagmi";
import { mainnet } from "wagmi/chains";
import { createPortal } from "react-dom";

// Inner component to properly use hooks
function ConnectButtonContent({
  account,
  chain,
  openAccountModal,
  openConnectModal,
  mounted,
  onSwitchNetwork,
}: {
  account: { displayName: string } | undefined;
  chain: { unsupported?: boolean } | undefined;
  openAccountModal: () => void;
  openConnectModal: () => void;
  mounted: boolean;
  onSwitchNetwork: () => void;
}) {
  const ready = mounted;
  const connected = ready && account && chain;
  // Derive modal visibility directly - no useEffect needed
  const isWrongNetwork = connected && chain.unsupported;

  return (
    <>
      <div
        {...(!ready && {
          "aria-hidden": true,
          style: {
            opacity: 0,
            pointerEvents: "none",
            userSelect: "none",
          },
        })}
      >
        {(() => {
          if (!connected) {
            return (
              <button
                onClick={openConnectModal}
                type="button"
                className="mono text-sm px-4 py-2 border border-[var(--border)] rounded-md hover:border-[var(--border-hover)] hover:bg-[var(--muted)] transition-all cursor-pointer"
              >
                Connect
              </button>
            );
          }

          return (
            <button
              onClick={isWrongNetwork ? onSwitchNetwork : openAccountModal}
              type="button"
              className={`mono text-sm px-4 py-2 border rounded-md transition-all cursor-pointer ${
                isWrongNetwork
                  ? "border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                  : "border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--muted)]"
              }`}
            >
              {account.displayName}
            </button>
          );
        })()}
      </div>

      {/* Wrong Network Modal - shown when on wrong network (derived, not state) */}
      {isWrongNetwork && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-medium mb-2">Wrong Network</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-6">
              yld_fi is only available on Ethereum mainnet. Please switch your network to continue.
            </p>
            <button
              onClick={onSwitchNetwork}
              className="w-full px-4 py-2 text-sm bg-white text-black rounded-md hover:bg-white/90 transition-all font-medium"
            >
              Switch to Ethereum
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export function CustomConnectButton() {
  const { switchChain } = useSwitchChain();

  const handleSwitchToEthereum = () => {
    switchChain({ chainId: mainnet.id });
  };

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openConnectModal,
        mounted,
      }) => (
        <ConnectButtonContent
          account={account}
          chain={chain}
          openAccountModal={openAccountModal}
          openConnectModal={openConnectModal}
          mounted={mounted}
          onSwitchNetwork={handleSwitchToEthereum}
        />
      )}
    </ConnectButton.Custom>
  );
}
