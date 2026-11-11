import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

  it("shows the error with a retry instead of the fallback route when there is no route", () => {
    const onRetry = vi.fn();
    render(<RouteDisplay inputSymbol="CVX" outputSymbol="ysCVX" errorMessage="No route available right now." onRetry={onRetry} />);

    expect(screen.getByText("No route available right now.")).toBeTruthy();
    expect(screen.queryByText("Direct swap")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("prefers the loading skeleton over the error while a quote is in flight", () => {
    render(<RouteDisplay inputSymbol="CVX" outputSymbol="ysCVX" isLoading errorMessage="No route available right now." />);

    expect(screen.queryByText("No route available right now.")).toBeNull();
  });

  it("shows the token logo for a known symbol, case-insensitively", () => {
    render(
      <RouteDisplay
        routeInfo={{ steps: [{ tokenSymbol: "Eth", action: "Swap", description: "ETH for CVX", protocol: "Curve" }] }}
      />,
    );

    expect(screen.getByAltText("Eth").getAttribute("src")).toBe("/tokens/eth.png");
  });

  it("maps lpxCVX to the pxCVX logo and the Union tokens to the Llama Airforce logo", () => {
    render(
      <RouteDisplay
        routeInfo={{
          steps: [
            { tokenSymbol: "lpxCVX", action: "Wrap", protocol: "Pirex" },
            { tokenSymbol: "uCVX", action: "Redeem", protocol: "Llama Airforce" },
            { tokenSymbol: "uCRV", action: "Redeem", protocol: "Llama Airforce" },
          ],
        }}
      />,
    );

    expect(screen.getByAltText("lpxCVX").getAttribute("src")).toBe("/tokens/pxcvx.png");
    expect(screen.getByAltText("uCVX").getAttribute("src")).toBe("/tokens/llama-airforce.png");
    expect(screen.getByAltText("uCRV").getAttribute("src")).toBe("/tokens/llama-airforce.png");
  });

  it("maps Yearn v3 symbols to their logo and falls back to the vault config logo", () => {
    render(
      <RouteDisplay
        routeInfo={{
          steps: [
            { tokenSymbol: "yvusdc-1", action: "Redeem", protocol: "Yearn" },
            { tokenSymbol: "yCVX", action: "Deposit", protocol: "yld" },
          ],
        }}
      />,
    );

    expect(screen.getByAltText("yvusdc-1").getAttribute("src")).toBe("/tokens/yearn-v3.svg");
    expect(screen.getByAltText("yCVX").getAttribute("src")).toBe("/ycvx-64.png");
  });

  it("falls back to the symbol initials when a token has no logo", () => {
    render(
      <RouteDisplay
        routeInfo={{ steps: [{ tokenSymbol: "UNKNOWN_TOKEN", action: "Swap", protocol: "Curve" }] }}
      />,
    );

    expect(screen.queryByAltText("UNKNOWN_TOKEN")).toBeNull();
    expect(screen.getByText("UN")).toBeTruthy();
  });

  it("links a known protocol with its display name", () => {
    render(
      <RouteDisplay
        routeInfo={{
          steps: [
            { tokenSymbol: "ETH", action: "Swap", description: "ETH for CVX", protocol: "enso" },
            { tokenSymbol: "CVX", action: "Swap", description: "CVX for pxCVX", protocol: "uniswap_v3" },
          ],
        }}
      />,
    );

    const enso = screen.getByRole("link", { name: /Enso/ });
    expect(enso.getAttribute("href")).toBe("https://enso.build");
    expect(enso.getAttribute("target")).toBe("_blank");

    const uniswap = screen.getByRole("link", { name: /Uniswap V3/ });
    expect(uniswap.getAttribute("href")).toBe("https://uniswap.org");
  });

  it("handles compound protocol names and their links", () => {
    render(
      <RouteDisplay
        routeInfo={{
          steps: [
            { tokenSymbol: "crvUSD", action: "Repay", description: "loan", protocol: "curve llamalend" },
            { tokenSymbol: "crvUSD", action: "Swap", description: "crvUSD for CVX", protocol: "cow swap" },
          ],
        }}
      />,
    );

    expect(screen.getByRole("link", { name: /Curve LlamaLend/ }).getAttribute("href")).toBe("https://www.curve.finance/lend");
    expect(screen.getByRole("link", { name: /CoW Swap/ }).getAttribute("href")).toBe("https://cow.fi");
  });

  it("resolves a protocol name by partial match", () => {
    render(
      <RouteDisplay
        routeInfo={{ steps: [{ tokenSymbol: "ETH", action: "Swap", protocol: "uniswap_v3_pool" }] }}
      />,
    );

    const link = screen.getByRole("link", { name: "Uniswap" });
    expect(link.getAttribute("href")).toBe("https://uniswap.org");
  });

  it("resolves a protocol link by reverse partial match", () => {
    render(
      <RouteDisplay
        routeInfo={{ steps: [{ tokenSymbol: "ETH", action: "Swap", protocol: "uni" }] }}
      />,
    );

    const link = screen.getByRole("link", { name: "Uni" });
    expect(link.getAttribute("href")).toBe("https://uniswap.org");
  });

  it("handles ether.fi, Rocket Pool and sushi name and link variants", () => {
    render(
      <RouteDisplay
        routeInfo={{
          steps: [
            { tokenSymbol: "ETH", action: "Stake", protocol: "ether.fi" },
            { tokenSymbol: "ETH", action: "Stake", protocol: "etherfi" },
            { tokenSymbol: "ETH", action: "Stake", protocol: "rocket pool" },
            { tokenSymbol: "ETH", action: "Stake", protocol: "rocketpool" },
            { tokenSymbol: "ETH", action: "Swap", protocol: "sushi" },
            { tokenSymbol: "ETH", action: "Swap", protocol: "sushiswap" },
          ],
        }}
      />,
    );

    const etherFi = screen.getAllByRole("link", { name: "Ether.fi" });
    expect(etherFi).toHaveLength(2);
    expect(etherFi.every((link) => link.getAttribute("href") === "https://ether.fi")).toBe(true);

    const rocketPool = screen.getAllByRole("link", { name: "Rocket Pool" });
    expect(rocketPool).toHaveLength(2);
    expect(rocketPool.every((link) => link.getAttribute("href") === "https://rocketpool.net")).toBe(true);

    expect(screen.getByRole("link", { name: "Sushi" }).getAttribute("href")).toBe("https://sushi.com");
    expect(screen.getByRole("link", { name: "SushiSwap" }).getAttribute("href")).toBe("https://sushi.com");
  });

  it("capitalizes an unknown protocol and renders it without a link", () => {
    render(
      <RouteDisplay
        routeInfo={{ steps: [{ tokenSymbol: "ETH", action: "Swap", description: "ETH for CVX", protocol: "newprotocol" }] }}
      />,
    );

    expect(screen.getByText("Newprotocol")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Newprotocol/ })).toBeNull();
  });

  it("labels a plain yld deposit as a yld vault", () => {
    const { container } = render(
      <RouteDisplay
        routeInfo={{ steps: [{ tokenSymbol: "CVX", action: "Deposit", protocol: "yld" }] }}
      />,
    );

    expect(container.textContent).toContain("Deposit into yld vault");
  });
});
