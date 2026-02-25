"use client";

import { useState, useEffect } from "react";
import { FileCode, Copy, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { LoadingDots } from "@/components/LoadingDots";

interface SourceFile {
  name: string;
  content: string;
}

// In-memory cache for source code (persists across component remounts)
// Bump CACHE_VERSION to invalidate old cached data
const CACHE_VERSION = "v3";
const sourceCache = new Map<string, {
  files: SourceFile[];
  timestamp: number;
  isProxy?: boolean;
  implementationAddress?: string | null;
}>();
const CACHE_DURATION = 1000 * 60 * 30; // 30 minutes

// Helper to create versioned cache key
function getCacheKey(address: string): string {
  return `${CACHE_VERSION}_${address.toLowerCase()}`;
}

interface ContractSourceViewerProps {
  address: string;
}

export function ContractSourceViewer({ address }: ContractSourceViewerProps) {
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileSelectorOpen, setFileSelectorOpen] = useState(false);
  const [isProxy, setIsProxy] = useState(false);
  const [implementationAddress, setImplementationAddress] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSource() {
      // Check cache first (using versioned key)
      const cacheKey = getCacheKey(address);
      const cached = sourceCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        setSourceFiles(cached.files);
        setSelectedFile(cached.files[0]?.name || null);
        setIsProxy(cached.isProxy || false);
        setImplementationAddress(cached.implementationAddress || null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      setSourceFiles([]);
      setSelectedFile(null);
      setIsProxy(false);
      setImplementationAddress(null);

      try {
        // Fetch from our API route (handles server-side API key and caching)
        // Use cache: "no-store" to bypass browser HTTP cache (ensures fresh data)
        const response = await fetch(`/api/explorer?action=getSource&address=${address}`, {
          cache: "no-store",
        });
        const data = (await response.json()) as {
          error?: string;
          result?: {
            files: Array<{ name: string; content: string }>;
            name: string | null;
            compiler: string | null;
            isProxy?: boolean;
            implementationAddress?: string | null;
          };
        };

        if (!response.ok || data.error) {
          throw new Error(data.error || "Contract source not found or not verified");
        }

        const result = data.result;
        if (!result?.files || result.files.length === 0) {
          throw new Error("Contract source code not available");
        }

        // Use files directly from API
        const files: SourceFile[] = result.files;

        // Handle proxy info
        const proxyInfo = result.isProxy || false;
        const implAddr = result.implementationAddress || null;
        setIsProxy(proxyInfo);
        setImplementationAddress(implAddr);

        // Cache the result (using versioned key)
        sourceCache.set(cacheKey, {
          files,
          timestamp: Date.now(),
          isProxy: proxyInfo,
          implementationAddress: implAddr,
        });

        setSourceFiles(files);
        setSelectedFile(files[0]?.name || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch source code");
      } finally {
        setLoading(false);
      }
    }

    if (address && address.length === 42) {
      fetchSource();
    } else {
      setLoading(false);
      setError("Invalid contract address");
    }
  }, [address]);

  const currentFile = sourceFiles.find((f) => f.name === selectedFile);

  const handleCopy = () => {
    if (currentFile) {
      navigator.clipboard.writeText(currentFile.content);
      toast.success("Copied to clipboard", { id: "copy-source" });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <LoadingDots />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-center">
        <FileCode className="w-10 h-10 text-[var(--muted-foreground)] mb-3" />
        <p className="text-[var(--muted-foreground)] text-sm">{error}</p>
        <a
          href={`https://etherscan.io/address/${address}#code`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 text-sm text-[var(--muted-foreground)] hover:text-[var(--accent)] transition-colors"
        >
          View on Etherscan →
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Proxy notice */}
      {isProxy && implementationAddress && (
        <div className="mb-3 px-3 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded-lg text-sm">
          <span className="text-[var(--accent)]">Proxy Contract</span>
          <span className="text-[var(--muted-foreground)]"> — showing implementation source at </span>
          <a
            href={`https://etherscan.io/address/${implementationAddress}#code`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-[var(--muted-foreground)] hover:text-[var(--accent)] transition-colors"
          >
            {implementationAddress.slice(0, 6)}...{implementationAddress.slice(-4)}
          </a>
        </div>
      )}

      {/* File selector and actions */}
      <div className="flex items-center justify-between mb-3 gap-4">
        {/* File selector dropdown */}
        {sourceFiles.length > 1 ? (
          <div className="relative">
            <button
              onClick={() => setFileSelectorOpen(!fileSelectorOpen)}
              className="flex items-center gap-2 px-3 py-1.5 bg-[var(--muted)] rounded-lg text-sm hover:text-[var(--accent)] transition-colors"
            >
              <FileCode size={14} className="text-[var(--accent)]" />
              <span className="mono text-[var(--foreground)]">{selectedFile}</span>
              <ChevronDown
                size={14}
                className={cn("transition-transform text-[var(--muted-foreground)]", fileSelectorOpen && "rotate-180")}
              />
            </button>
            {fileSelectorOpen && (
              <div className="absolute top-full left-0 mt-1 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg z-10 min-w-[280px] max-h-[300px] overflow-y-auto py-1">
                {sourceFiles.map((file) => (
                  <button
                    key={file.name}
                    onClick={() => {
                      setSelectedFile(file.name);
                      setFileSelectorOpen(false);
                    }}
                    className={cn(
                      "w-full px-3 py-2 text-left text-sm mono hover:bg-[var(--muted)] transition-colors flex items-center gap-2",
                      file.name === selectedFile && "bg-[var(--muted)] border-l-2 border-l-[var(--accent)]"
                    )}
                  >
                    <FileCode size={12} className={cn("shrink-0", file.name === selectedFile ? "text-[var(--accent)]" : "text-[var(--muted-foreground)]")} />
                    <span className="truncate">{file.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <FileCode size={14} className="text-[var(--accent)]" />
            <span className="mono text-[var(--foreground)]">{selectedFile}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted-foreground)]">
            {sourceFiles.length} file{sourceFiles.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 text-xs bg-[var(--muted)] rounded text-[var(--foreground)] hover:text-[var(--accent)] transition-colors"
          >
            <Copy size={12} />
            Copy
          </button>
          <a
            href={`https://etherscan.io/address/${address}#code`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-1 text-xs bg-[var(--muted)] rounded text-[var(--foreground)] hover:text-[var(--accent)] transition-colors"
          >
            Etherscan
          </a>
        </div>
      </div>

      {/* Source code - constrained height so it's visible without scrolling */}
      <div className="flex-1 min-h-0 max-h-[calc(100vh-400px)] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--card)]">
        <pre className="p-4 text-xs mono leading-relaxed">
          <code>
            {currentFile?.content.split("\n").map((line, i) => (
              <div key={i} className="flex hover:bg-[var(--muted)]/50">
                <span className="inline-block w-10 pr-3 text-right text-[var(--muted-foreground)]/50 select-none shrink-0 border-r border-[var(--border)]/50 mr-3">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-all text-[var(--foreground)]/90">{highlightSolidity(line)}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

// Solidity syntax highlighting using accent color scheme
function highlightSolidity(line: string): React.ReactNode {
  // Full-line comments
  if (line.trim().startsWith("//")) {
    return <span className="text-[var(--muted-foreground)]/70">{line}</span>;
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  // Combined pattern for keywords, comments, strings, numbers, and special values
  const combinedPattern = /(\b(?:pragma|solidity|contract|interface|library|function|modifier|event|struct|enum|mapping|address|bool|string|bytes\d*|u?int\d*|public|private|internal|external|view|pure|payable|memory|storage|calldata|returns?|if|else|for|while|do|break|continue|return|import|using|is|new|delete|emit|revert|require|assert|constructor|fallback|receive|virtual|override|abstract|immutable|constant)\b)|(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-fA-F]+\b)|(\b(?:true|false|msg|block|tx|abi)\b)/g;

  let match;
  while ((match = combinedPattern.exec(line)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Keywords - accent color
      parts.push(<span key={match.index} className="text-[var(--accent)]">{match[0]}</span>);
    } else if (match[2]) {
      // Comments - muted
      parts.push(<span key={match.index} className="text-[var(--muted-foreground)]/70">{match[0]}</span>);
    } else if (match[3]) {
      // Strings - slightly lighter accent
      parts.push(<span key={match.index} className="text-[#fbbf24]">{match[0]}</span>);
    } else if (match[4]) {
      // Numbers - dimmed accent
      parts.push(<span key={match.index} className="text-[#d97706]">{match[0]}</span>);
    } else if (match[5]) {
      // Special values (true, false, msg, etc.) - brighter
      parts.push(<span key={match.index} className="text-[#fcd34d]">{match[0]}</span>);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }

  return parts.length > 0 ? parts : line;
}
