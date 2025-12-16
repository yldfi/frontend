"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSwitchChain } from "wagmi";
import { mainnet } from "wagmi/chains";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

export function CustomConnectButton() {
  const { switchChain } = useSwitchChain();
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  const handleSwitchToEthereum = () => {
    switchChain({ chainId: mainnet.id });
    setShowNetworkModal(false);
  };

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openConnectModal,
        mounted,
      }) => {
        const ready = mounted;
        const connected = ready && account && chain;
        const isWrongNetwork = connected && chain.unsupported;

        // Show modal when on wrong network
        useEffect(() => {
          if (isWrongNetwork) {
            setShowNetworkModal(true);
          } else {
            setShowNetworkModal(false);
          }
        }, [isWrongNetwork]);

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
                    onClick={isWrongNetwork ? () => setShowNetworkModal(true) : openAccountModal}
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

            {/* Wrong Network Modal - rendered via portal to body */}
            {showNetworkModal && isWrongNetwork && typeof document !== "undefined" && createPortal(
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-lg p-6 max-w-sm w-full shadow-xl">
                  <h3 className="text-lg font-medium mb-2">Wrong Network</h3>
                  <p className="text-sm text-[var(--muted-foreground)] mb-6">
                    YLD.fi is only available on Ethereum mainnet. Please switch your network to continue.
                  </p>
                  <button
                    onClick={handleSwitchToEthereum}
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
      }}
    </ConnectButton.Custom>
  );
}
