import { describe, expect, it } from "vitest";
import { SAFE_LOG_MAX_LENGTH, safeLogData, upstreamErrorBody } from "@/lib/safe-log";

describe("safeLogData", () => {
  it("returns undefined for undefined and null", () => {
    expect(safeLogData(undefined)).toBeUndefined();
    expect(safeLogData(null)).toBeUndefined();
  });

  it("passes a string through unchanged", () => {
    expect(safeLogData("Upstream said no")).toBe("Upstream said no");
  });

  it("serialises an object", () => {
    expect(safeLogData({ message: "boom", detail: "why" })).toBe(
      '{"message":"boom","detail":"why"}',
    );
  });

  it("reduces a URL in a nested object to its host", () => {
    const logged = safeLogData({ a: { url: "https://private.node.example/rpc/secret-key" } });

    expect(logged).toContain("private.node.example");
    expect(logged).not.toContain("secret-key");
    expect(logged).not.toContain("/rpc/");
  });

  it("never writes more than the default limit", () => {
    expect(safeLogData("x".repeat(SAFE_LOG_MAX_LENGTH * 4))).toHaveLength(SAFE_LOG_MAX_LENGTH);
  });

  it("honours a custom limit", () => {
    expect(safeLogData({ text: "x".repeat(100) }, 20)).toHaveLength(20);
  });

  it("marks a circular value as unserialisable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(safeLogData(circular)).toBe("[unserialisable]");
  });

  it("marks a BigInt as unserialisable", () => {
    expect(safeLogData({ amount: BigInt(1) })).toBe("[unserialisable]");
  });

  it("collapses whitespace runs to one space", () => {
    expect(safeLogData("first\n\nsecond\t\tthird")).toBe("first second third");
  });

  it("bounds a very long string quickly", () => {
    const started = performance.now();
    const logged = safeLogData("a".repeat(100_000));

    expect(performance.now() - started).toBeLessThan(50);
    expect(logged).toHaveLength(SAFE_LOG_MAX_LENGTH);
  });
});

describe("upstreamErrorBody", () => {
  it("prefers responseData over response.data", () => {
    const error = Object.assign(new Error("boom"), {
      responseData: { source: "responseData" },
      response: { data: { source: "response.data" } },
    });

    expect(upstreamErrorBody(error)).toEqual({ source: "responseData" });
  });

  it("falls back to response.data when responseData is undefined", () => {
    const error = Object.assign(new Error("boom"), {
      responseData: undefined,
      response: { data: { source: "response.data" } },
    });

    expect(upstreamErrorBody(error)).toEqual({ source: "response.data" });
  });

  it("returns a null responseData as null", () => {
    expect(upstreamErrorBody({ responseData: null })).toBeNull();
  });

  it("returns undefined when the value carries no upstream body", () => {
    expect(upstreamErrorBody("boom")).toBeUndefined();
    expect(upstreamErrorBody(undefined)).toBeUndefined();
    expect(upstreamErrorBody(null)).toBeUndefined();
    expect(upstreamErrorBody(42)).toBeUndefined();
  });
});
