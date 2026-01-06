import "@testing-library/dom";
import { vi } from "vitest";

// Mock window.gtag for analytics tests
Object.defineProperty(globalThis, "gtag", {
  value: vi.fn(),
  writable: true,
});

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Mock fetch for API tests
Object.defineProperty(globalThis, "fetch", {
  value: vi.fn(),
  writable: true,
});

// Mock wagmi hooks and utilities
vi.mock("wagmi", () => ({
  useReadContracts: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
  useReadContract: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
  useAccount: vi.fn(() => ({
    address: undefined,
    isConnected: false,
  })),
  usePublicClient: vi.fn(() => ({
    readContract: vi.fn(),
  })),
  useWriteContract: vi.fn(() => ({
    writeContract: vi.fn(),
    writeContractAsync: vi.fn(),
    data: undefined,
    isPending: false,
    error: null,
  })),
  useWaitForTransactionReceipt: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isSuccess: false,
  })),
  useSendTransaction: vi.fn(() => ({
    sendTransaction: vi.fn(),
    sendTransactionAsync: vi.fn(),
    data: undefined,
    isPending: false,
    error: null,
  })),
  useChainId: vi.fn(() => 1),
  useConfig: vi.fn(() => ({})),
  useBalance: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
  // Transport utilities used by wagmi config
  http: vi.fn(() => ({})),
  fallback: vi.fn((...transports: unknown[]) => transports),
  unstable_connector: vi.fn(() => ({})),
}));

// Mock @tanstack/react-query
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  })),
  QueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock CookieConsent for analytics tests
vi.mock("@/components/CookieConsent", () => ({
  isAnalyticsAllowed: vi.fn(() => true),
  getConsentStatus: vi.fn(() => "accepted"),
}));
