import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RouteDisplay } from "@/components/RouteDisplay";

describe("RouteDisplay rendering", () => {
  it("uses via for deposit steps that already describe the destination", () => {
    const { container } = render(
      <RouteDisplay
        routeInfo={{
          steps: [
            {
              tokenSymbol: "pxCVX",
              amount: "11.3112",
              action: "Deposit",
              description: "pxCVX into uCVX",
              protocol: "Llama Airforce",
            },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Deposit pxCVX into uCVX via Llama Airforce");
    expect(container.textContent).not.toContain("Deposit pxCVX into uCVX into Llama Airforce");
  });

  it("hides repeated protocol text on the terminal receive step", () => {
    const { container } = render(
      <RouteDisplay
        routeInfo={{
          steps: [
            {
              tokenSymbol: "pxCVX",
              amount: "11.3112",
              action: "Deposit",
              description: "pxCVX into uCVX",
              protocol: "Llama Airforce",
            },
            {
              tokenSymbol: "uCVX",
              amount: "5.0554",
              action: "Receive",
              description: "vault shares",
              protocol: "Llama Airforce",
            },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Receive vault shares");
    expect(container.textContent?.match(/Llama Airforce/g)).toHaveLength(1);
  });

  it("preserves explicit split amounts on the first hybrid route step", () => {
    const { container } = render(
      <RouteDisplay
        inputAmount="100000.0000"
        outputAmount="100001.2134"
        routeInfo={{
          steps: [
            {
              tokenSymbol: "CVX",
              amount: "18043.2485",
              action: "Swap",
              description: "CVX for pxCVX",
              protocol: "Curve",
              bonus: 0.0067,
              bonusAmount: "1.2134",
              bonusSymbol: "pxCVX",
            },
            {
              tokenSymbol: "CVX",
              amount: "81956.7515",
              action: "Mint",
              description: "pxCVX with CVX (1:1)",
              protocol: "Pirex",
            },
            {
              tokenSymbol: "pxCVX",
              action: "Receive",
              description: "tokens",
              protocol: "Pirex",
            },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("18043.2485CVX");
    expect(container.textContent).toContain("81956.7515CVX");
    expect(container.textContent).not.toContain("100000.0000CVXSwap");
    expect(container.textContent).toContain("100001.2134pxCVX");
  });
});
