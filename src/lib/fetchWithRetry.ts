/**
 * Fetch with exponential backoff retry logic
 * Use for external API calls that may temporarily fail
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;  // milliseconds
  maxDelay?: number;   // milliseconds
  retryOn?: (response: Response) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  retryOn: (res) => res.status >= 500 || res.status === 429,
};

/**
 * Fetch with automatic retry on failure
 * Uses exponential backoff with jitter
 */
export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const { maxRetries, baseDelay, maxDelay, retryOn } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      // Check if we should retry based on response
      if (!response.ok && retryOn(response) && attempt < maxRetries) {
        // Calculate delay with exponential backoff and jitter
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
          maxDelay
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      // Retry on network errors
      if (attempt < maxRetries) {
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
          maxDelay
        );
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError || new Error("Failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
