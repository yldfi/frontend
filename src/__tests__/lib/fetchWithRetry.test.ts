import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

describe("fetchWithRetry", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create a fresh mock for each test
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns successful response on first try", async () => {
    const mockResponse = new Response(JSON.stringify({ data: "test" }), {
      status: 200,
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await fetchWithRetry("https://api.test.com/data");

    expect(result).toBe(mockResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 error and succeeds", async () => {
    const errorResponse = new Response("Server Error", { status: 500 });
    const successResponse = new Response(JSON.stringify({ data: "test" }), {
      status: 200,
    });

    mockFetch
      .mockResolvedValueOnce(errorResponse)
      .mockResolvedValueOnce(successResponse);

    // Use very short delays for testing
    const result = await fetchWithRetry("https://api.test.com/data", undefined, {
      baseDelay: 1,
      maxDelay: 5,
      maxRetries: 3,
    });

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const rateLimitResponse = new Response("Too Many Requests", { status: 429 });
    const successResponse = new Response("OK", { status: 200 });

    mockFetch
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await fetchWithRetry("https://api.test.com/data", undefined, {
      baseDelay: 1,
      maxDelay: 5,
      maxRetries: 2,
    });

    expect(result.status).toBe(200);
  });

  it("returns error response after max retries", async () => {
    const errorResponse = new Response("Server Error", { status: 500 });
    mockFetch.mockResolvedValue(errorResponse);

    const result = await fetchWithRetry("https://api.test.com/data", undefined, {
      maxRetries: 2,
      baseDelay: 1,
      maxDelay: 5,
    });

    expect(result.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it("does not retry on 400 client error by default", async () => {
    const clientError = new Response("Bad Request", { status: 400 });
    mockFetch.mockResolvedValueOnce(clientError);

    const result = await fetchWithRetry("https://api.test.com/data");

    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("respects custom retryOn function", async () => {
    const notFoundResponse = new Response("Not Found", { status: 404 });
    const successResponse = new Response("OK", { status: 200 });

    mockFetch
      .mockResolvedValueOnce(notFoundResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await fetchWithRetry("https://api.test.com/data", undefined, {
      baseDelay: 1,
      maxDelay: 5,
      maxRetries: 2,
      retryOn: (res) => res.status === 404, // Custom: retry on 404
    });

    expect(result.status).toBe(200);
  });

  it("retries on network error", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));

    const result = await fetchWithRetry("https://api.test.com/data", undefined, {
      baseDelay: 1,
      maxDelay: 5,
      maxRetries: 2,
    });

    expect(result.status).toBe(200);
  });

  it("throws after max retries on network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await expect(
      fetchWithRetry("https://api.test.com/data", undefined, {
        maxRetries: 2,
        baseDelay: 1,
        maxDelay: 5,
      })
    ).rejects.toThrow("Network error");

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on AbortError", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      fetchWithRetry("https://api.test.com/data", undefined, {
        maxRetries: 3,
        baseDelay: 1,
      })
    ).rejects.toThrow("Aborted");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes request init options to fetch", async () => {
    const mockResponse = new Response("OK", { status: 200 });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    };

    await fetchWithRetry("https://api.test.com/data", init);

    expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/data", init);
  });

  it("accepts URL object", async () => {
    const mockResponse = new Response("OK", { status: 200 });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const url = new URL("https://api.test.com/data");
    await fetchWithRetry(url);

    expect(mockFetch).toHaveBeenCalledWith(url, undefined);
  });

  it("handles non-Error thrown values", async () => {
    mockFetch.mockRejectedValue("string error");

    await expect(
      fetchWithRetry("https://api.test.com/data", undefined, {
        maxRetries: 0,
      })
    ).rejects.toThrow("string error");
  });
});
