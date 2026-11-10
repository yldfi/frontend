import { describe, it, expect } from "vitest";
import { appendDynamicRouteFloor } from "@/lib/enso";
import type { EnsoBundleAction } from "@/types/enso";

const route = (): EnsoBundleAction => ({
  protocol: "enso",
  action: "route",
  args: { tokenIn: "0xA", tokenOut: "0xB", amountIn: { useOutputOfCallAt: 0 }, slippage: "50" },
});

describe("appendDynamicRouteFloor", () => {
  it("adds a minamountout on the route's output at estimate × (1 − max(5%, slippage + 1%))", () => {
    const actions: EnsoBundleAction[] = [route()];
    appendDynamicRouteFloor(actions, 0, 1_000_000n, "50");
    expect(actions[1]).toEqual({
      protocol: "enso",
      action: "minamountout",
      args: { amountOut: { useOutputOfCallAt: 0 }, minAmountOut: "950000" },
    });
  });

  it("widens with high slippage (10% → 11% tolerance)", () => {
    const actions: EnsoBundleAction[] = [route()];
    appendDynamicRouteFloor(actions, 0, "1000000", "1000");
    expect(actions[1].args.minAmountOut).toBe("890000");
  });

  it("goes right after the route so a trailing ETH unwrap stays last", () => {
    const unwrap = { protocol: "wrapped-native", action: "redeem", args: { amountIn: { useOutputOfCallAt: 0 } } } as EnsoBundleAction;
    const actions: EnsoBundleAction[] = [route(), unwrap];
    appendDynamicRouteFloor(actions, 0, 2_000_000n, "50");
    expect(actions[1]).toMatchObject({ action: "minamountout", args: { amountOut: { useOutputOfCallAt: 0 } } });
    expect(actions[2]).toBe(unwrap);
  });

  it("refuses to splice when a later action references a later output", () => {
    const actions: EnsoBundleAction[] = [
      route(),
      { protocol: "enso", action: "balance", args: { token: "0xB" } } as EnsoBundleAction,
      { protocol: "erc4626", action: "deposit", args: { amountIn: { useOutputOfCallAt: 1 } } } as EnsoBundleAction,
    ];
    expect(() => appendDynamicRouteFloor(actions, 0, 1_000_000n, "50")).toThrow(/later outputs/);
  });

  it("does nothing without an estimate", () => {
    const actions: EnsoBundleAction[] = [route()];
    appendDynamicRouteFloor(actions, 0, "0", "50");
    expect(actions).toHaveLength(1);
  });

  it("refuses to point at anything but a route", () => {
    const actions: EnsoBundleAction[] = [{ protocol: "enso", action: "balance", args: { token: "0xA" } } as EnsoBundleAction];
    expect(() => appendDynamicRouteFloor(actions, 0, 1n, "50")).toThrow(/route action/);
  });
});
