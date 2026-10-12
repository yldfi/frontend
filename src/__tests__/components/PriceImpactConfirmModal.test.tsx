import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PRICE_IMPACT_CONFIRM_THRESHOLD, PriceImpactConfirmModal, needsPriceImpactConfirm } from "@/components/PriceImpactConfirmModal";

describe("PriceImpactConfirmModal", () => {
  it.each([
    [null, false],
    [undefined, false],
    [-3, false],
    [4.99, false],
    [PRICE_IMPACT_CONFIRM_THRESHOLD, true],
    [99.99, true],
  ])("needsPriceImpactConfirm(%s) is %s", (impact, expected) => {
    expect(needsPriceImpactConfirm(impact)).toBe(expected);
  });

  it("only confirms once CONFIRM is typed (case-insensitive) and cancels from the backdrop", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(<PriceImpactConfirmModal priceImpact={12.345} confirmLabel="Zap" onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByText("12.35%")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Zap" }) as HTMLButtonElement;
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Type CONFIRM to proceed"), { target: { value: "confir" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type CONFIRM to proceed"), { target: { value: "confirm" } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".backdrop-blur-sm")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
