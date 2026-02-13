"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { useTenderly } from "@/contexts/TenderlyContext";
import { useConnect, useDisconnect } from "wagmi";

export default function DebugPage() {
  const { address, connector, isConnected, chain } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { isTestNetwork, testNetworkType, isDetecting } = useTenderly();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const [rpcProbeResult, setRpcProbeResult] = useState<string>("");
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [transportProbeResult, setTransportProbeResult] = useState<string>("");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [providerInfo, setProviderInfo] = useState<string>("Loading...");
  const [copied, setCopied] = useState(false);

  // Probe evm_snapshot via wallet provider
  useEffect(() => {
    if (!isConnected || !connector) {
      return;
    }

    async function probeRpc() {
      try {
        const provider = await connector!.getProvider();
        if (!provider) {
          setRpcProbeResult("No provider");
          return;
        }

        // Get provider info
        const providerAny = provider as Record<string, unknown>;
        setProviderInfo(JSON.stringify({
          isMetaMask: providerAny.isMetaMask,
          isCoinbaseWallet: providerAny.isCoinbaseWallet,
          isFrame: providerAny.isFrame,
          is1inch: providerAny.is1inch,
          isRabby: providerAny.isRabby,
          isTrust: providerAny.isTrust,
          isWalletConnect: providerAny.isWalletConnect,
          chainId: providerAny.chainId,
        }, null, 2));

        try {
          const result = await (provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request({
            method: "evm_snapshot",
            params: [],
          });
          setRpcProbeResult(`SUCCESS: ${JSON.stringify(result)}`);
          setRpcError(null);
        } catch (err: unknown) {
          const error = err as { code?: number; message?: string; error?: { code?: number; message?: string } };
          const errorCode = error?.code || error?.error?.code;
          const errorMsg = error?.message || error?.error?.message || String(err);

          setRpcProbeResult(`ERROR code: ${errorCode}`);
          setRpcError(errorMsg);
        }
      } catch (err) {
        setRpcProbeResult(`Provider error: ${err}`);
      }
    }

    probeRpc();
  }, [isConnected, connector]);

  // Probe evm_snapshot via wagmi transport (direct HTTP to configured RPC)
  useEffect(() => {
    if (!publicClient) return;

    async function probeTransport() {
      try {
        const result = await publicClient!.transport.request({ method: "evm_snapshot", params: [] });
        try {
          await publicClient!.transport.request({ method: "anvil_nodeInfo", params: [] });
          setTransportProbeResult(`SUCCESS (Anvil): ${JSON.stringify(result)}`);
        } catch {
          setTransportProbeResult(`SUCCESS (Tenderly): ${JSON.stringify(result)}`);
        }
        setTransportError(null);
      } catch (err: unknown) {
        const error = err as { code?: number; message?: string; error?: { code?: number; message?: string } };
        const errorCode = error?.code || error?.error?.code;
        const errorMsg = error?.message || error?.error?.message || String(err);
        setTransportProbeResult(`ERROR code: ${errorCode}`);
        setTransportError(errorMsg);
      }
    }

    probeTransport();
  }, [publicClient]);

  const copyAll = useCallback(() => {
    const debugData = {
      timestamp: new Date().toISOString(),
      connection: {
        isConnected,
        address,
        connector: connector?.name,
        connectorId: connector?.id,
      },
      chain: {
        chainId,
        chainIdFromAccount: chain?.id,
        chainName: chain?.name,
        isMainnet: chainId === 1,
      },
      testNetwork: {
        isDetecting,
        isTestNetwork,
        testNetworkType,
      },
      rpcProbe: {
        result: rpcProbeResult || (isConnected ? "Testing..." : "Not connected"),
        error: rpcError,
      },
      provider: providerInfo,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "N/A",
    };

    navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [isConnected, address, connector, chainId, chain, isDetecting, isTestNetwork, testNetworkType, rpcProbeResult, rpcError, providerInfo]);

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Connection Debug Info</h1>
        <button
          onClick={copyAll}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          {copied ? (
            <>
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-green-400">Copied!</span>
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>Copy All</span>
            </>
          )}
        </button>
      </div>

      <div className="space-y-6 font-mono text-sm">
        <Section title="Connection Status">
          <Row label="Connected" value={isConnected ? "Yes" : "No"} />
          <Row label="Address" value={address || "Not connected"} />
          <Row label="Connector" value={connector?.name || "None"} />
          <Row label="Connector ID" value={connector?.id || "None"} />

          <div className="mt-4 flex flex-wrap gap-2">
            {!isConnected ? (
              connectors.map((c, i) => (
                <button
                  key={`${c.id}-${i}`}
                  onClick={() => connect({ connector: c })}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
                >
                  Connect {c.name}
                </button>
              ))
            ) : (
              <button
                onClick={() => disconnect()}
                className="px-3 py-2 bg-red-600 hover:bg-red-500 rounded text-sm"
              >
                Disconnect
              </button>
            )}
          </div>
        </Section>

        <Section title="Chain Info">
          <Row label="Chain ID (useChainId)" value={String(chainId)} />
          <Row label="Chain ID (useAccount)" value={String(chain?.id || "N/A")} />
          <Row label="Chain Name" value={chain?.name || "Unknown"} />
          <Row label="Is Mainnet" value={chainId === 1 ? "Yes" : "No"} />
        </Section>

        <Section title="Test Network Detection">
          <Row label="Is Detecting" value={isDetecting ? "Yes..." : "No"} />
          <Row
            label="Is Test Network"
            value={isTestNetwork ? `YES (${testNetworkType})` : "No (Mainnet)"}
            highlight={isTestNetwork}
          />
        </Section>

        <Section title="RPC Probe — Wallet Provider">
          <Row label="Result" value={rpcProbeResult || (isConnected ? "Testing..." : "Not connected")} highlight={rpcProbeResult.startsWith("SUCCESS")} />
          {rpcError && <Row label="Error" value={rpcError} />}
          <div className="mt-2 text-xs text-zinc-500">
            Tests evm_snapshot via the wallet extension. Some wallets (e.g. Rabby) filter non-standard methods and return -32601 even on Anvil.
          </div>
        </Section>

        <Section title="RPC Probe — Wagmi Transport">
          <Row label="Result" value={transportProbeResult || "Testing..."} highlight={transportProbeResult.startsWith("SUCCESS")} />
          {transportError && <Row label="Error" value={transportError} />}
          <div className="mt-2 text-xs text-zinc-500">
            Tests evm_snapshot via wagmi&apos;s HTTP transport (bypasses wallet). Uses NEXT_PUBLIC_ANVIL_RPC when set. This is the fallback used for detection when the wallet blocks the probe.
          </div>
        </Section>

        <Section title="Provider Info">
          <pre className="bg-zinc-900 p-3 rounded overflow-auto text-xs">
            {providerInfo}
          </pre>
        </Section>

        <Section title="User Agent">
          <pre className="bg-zinc-900 p-3 rounded overflow-auto text-xs break-all">
            {typeof navigator !== "undefined" ? navigator.userAgent : "N/A"}
          </pre>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <h2 className="text-lg font-semibold mb-3 text-zinc-400">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{label}:</span>
      <span className={highlight ? "text-amber-400 font-bold" : "text-white"}>{value}</span>
    </div>
  );
}
