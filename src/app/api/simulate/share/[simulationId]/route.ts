import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ simulationId: string }> }
) {
  const { simulationId } = await params;

  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG;
  const accessKey = process.env.TENDERLY_ACCESS_KEY;

  if (!accountSlug || !projectSlug || !accessKey) {
    return NextResponse.json(
      { error: "Tenderly not configured" },
      { status: 500 }
    );
  }

  if (!simulationId || !/^[a-f0-9-]+$/i.test(simulationId)) {
    return NextResponse.json(
      { error: "Invalid simulation ID" },
      { status: 400 }
    );
  }

  // Share the simulation publicly
  let url = `https://dashboard.tenderly.co/${accountSlug}/${projectSlug}/simulator/${simulationId}`;

  try {
    const shareResponse = await fetch(
      `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/simulations/${simulationId}/share`,
      {
        method: "POST",
        headers: { "X-Access-Key": accessKey },
      }
    );

    if (shareResponse.ok) {
      // Use the public shared URL
      url = `https://dashboard.tenderly.co/shared/simulation/${simulationId}`;
    }
  } catch {
    // Use fallback URL
  }

  return NextResponse.json({ url });
}
