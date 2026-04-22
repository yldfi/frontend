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
});
