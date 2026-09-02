"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSwitchChain } from "wagmi";
import { mainnet } from "wagmi/chains";
import { createPortal } from "react-dom";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";

function SafeWalletMark() {
  return (
    <svg
      aria-label="Safe wallet"
      className="size-4 shrink-0 text-[#12ff80]"
      fill="none"
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M21.757 11.998h-2.485c-.742 0-1.343.579-1.343 1.293v3.47c0 .714-.602 1.293-1.344 1.293H6.699c-.743 0-1.344.578-1.344 1.292v2.391c0 .714.601 1.293 1.344 1.293h10.458c.742 0 1.335-.579 1.335-1.293V19.82c0-.714.602-1.22 1.344-1.22h1.92c.743 0 1.344-.58 1.344-1.293v-4.03c0-.714-.601-1.278-1.343-1.278ZM5.355 7.249c0-.714.6-1.293 1.343-1.293h9.88c.743 0 1.344-.579 1.344-1.293v-2.39c0-.714-.601-1.293-1.344-1.293H6.125c-.742 0-1.343.579-1.343 1.293v1.842c0 .714-.602 1.292-1.344 1.292H1.526C.784 5.407.182 5.986.182 6.7v4.034c0 .714.604 1.264 1.346 1.264h2.485c.743 0 1.344-.579 1.344-1.293L5.355 7.25ZM10.472 9.485h2.387c.778 0 1.409.608 1.409 1.356v2.296c0 .748-.632 1.356-1.41 1.356h-2.386c-.778 0-1.409-.608-1.409-1.356v-2.296c0-.749.632-1.356 1.409-1.356Z"
        fill="currentColor"
      />
    </svg>
  );
}

// Inner component to properly use hooks
export function ConnectButtonContent({
  account,
  chain,
  openAccountModal,
  openConnectModal,
  mounted,
  onSwitchNetwork,
}: {
  account: { address: string; displayName: string } | undefined;
  chain: { id: number; unsupported?: boolean } | undefined;
  openAccountModal: () => void;
  openConnectModal: () => void;
  mounted: boolean;
  onSwitchNetwork: () => void;
}) {
  const ready = mounted;
  const connected = ready && account && chain;
  const isSafeWallet = useIsSafeWallet(account?.address, chain?.id);
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
              className={`mono text-sm px-3 sm:px-4 py-2 border rounded-md transition-all cursor-pointer truncate max-w-[140px] sm:max-w-none ${
                isWrongNetwork
                  ? "border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                  : "border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--muted)]"
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {isSafeWallet && <SafeWalletMark />}
                <span className="truncate">{account.displayName}</span>
              </span>
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
              yld is only available on Ethereum mainnet. Please switch your network to continue.
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
  const { vnetAvailable, vnetEnabled, toggleVNet } = useTestNetwork();

  const handleSwitchToEthereum = () => {
    switchChain({ chainId: mainnet.id });
  };

  return (
    <div className="flex items-center gap-2">
      {vnetAvailable && (
        <button
          onClick={toggleVNet}
          type="button"
          className={`mono text-xs px-2.5 py-1.5 border rounded-md transition-all cursor-pointer ${
            vnetEnabled
              ? "border-cyan-500 text-cyan-400 bg-cyan-500/10"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--border-hover)]"
          }`}
        >
          VNet
        </button>
      )}
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
    </div>
  );
}
