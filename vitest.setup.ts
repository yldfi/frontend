import "@testing-library/dom";
import { vi } from "vitest";

// Mock window.gtag for analytics tests
Object.defineProperty(globalThis, "gtag", {
  value: vi.fn(),
  writable: true,
});
