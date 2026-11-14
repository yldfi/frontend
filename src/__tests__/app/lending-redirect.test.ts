import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  permanentRedirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

import { permanentRedirect } from "next/navigation";
import LendingRedirect from "@/app/vaults/[id]/lending/page";

const mockedRedirect = vi.mocked(permanentRedirect);

describe("/vaults/[id]/lending redirect", () => {
  it("permanently redirects to the vault page", async () => {
    await expect(
      LendingRedirect({ params: Promise.resolve({ id: "ycvxcrv" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/vaults/ycvxcrv");

    expect(mockedRedirect).toHaveBeenCalledWith("/vaults/ycvxcrv");
  });

  it("encodes an id that contains a slash", async () => {
    await expect(
      LendingRedirect({ params: Promise.resolve({ id: "a/b" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/vaults/a%2Fb");

    expect(mockedRedirect).toHaveBeenCalledWith("/vaults/a%2Fb");
  });
});
