import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SimulationModal } from "@/components/SimulationModal";
import type { SimulationAssetChange } from "@/types/enso";

const assetChanges: SimulationAssetChange[] = [
  {
    type: "send",
    symbol: "yvUSDC-1",
    amount: "432.886349",
    rawAmount: "432886349",
    address: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204",
    decimals: 6,
    dollarValue: "478.28",
  },
  {
    type: "receive",
    symbol: "pxCVX",
    amount: "284.818161",
    rawAmount: "284818161000000000000",
    address: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC",
    decimals: 18,
    dollarValue: "463.55",
  },
];

function renderModal(routePriceImpact?: number | null) {
  return render(
    <SimulationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={vi.fn()}
      simulationResult={{
        success: true,
        gasUsed: 790430,
        errorMessage: null,
        tenderlyUrl: null,
        assetChanges,
      }}
      routePriceImpact={routePriceImpact}
    />,
  );
}

describe("SimulationModal", () => {
  it("renders a zero route price impact instead of falling back to Tenderly USD delta", () => {
    renderModal(0);

    expect(screen.getByText("Price Impact")).toBeTruthy();
    expect(screen.getByText("0.00%")).toBeTruthy();
    expect(screen.queryByText("-3.08%")).toBeNull();
  });

  it("hides aggregate price impact when the quote could not compute it", () => {
    renderModal(null);

    expect(screen.queryByText("Price Impact")).toBeNull();
    expect(screen.queryByText("-3.08%")).toBeNull();
  });
});

describe("simulation dollar value visibility", () => {
  function show(changes: SimulationAssetChange[]) {
    return render(<SimulationModal isOpen onClose={vi.fn()} onConfirm={vi.fn()}
      simulationResult={{ success: true, gasUsed: 613983, errorMessage: null, tenderlyUrl: null, assetChanges: changes }} />);
  }

  it.each([undefined, "0", "-10", "NaN", "Infinity"])("omits unusable dollar values (%s) but keeps token amounts", dollarValue => {
    show(assetChanges.map(c => ({ ...c, dollarValue })));
    expect(screen.getByText(/432.886349 yvUSDC-1/)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText("Price Impact")).toBeNull();
  });

  it("shows the priced row but omits impact for a partially priced swap", () => {
    show([{ ...assetChanges[0], dollarValue: undefined }, assetChanges[1]]);
    expect(screen.getByText("~$463.55")).toBeTruthy();
    expect(screen.queryByText("Price Impact")).toBeNull();
  });

  it("does not display a tiny positive value as zero", () => {
    show([{ ...assetChanges[0], dollarValue: "0.001" }]);
    expect(screen.getByText("~$<0.01")).toBeTruthy();
  });
});
