import { NextRequest, NextResponse } from "next/server";

/**
 * ENS Avatar CORS Proxy
 * Proxies requests to euc.li with proper CORS headers
 *
 * Usage: /api/avatar/vitalik.eth
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  if (!name || !name.includes(".")) {
    return NextResponse.json({ error: "Invalid ENS name" }, { status: 400 });
  }

  try {
    const avatarUrl = `https://euc.li/${name}`;
    const response = await fetch(avatarUrl, {
      headers: {
        "User-Agent": "yld_fi ENS Avatar Proxy",
      },
    });

    if (!response.ok) {
      return new NextResponse("Avatar not found", {
        status: response.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const body = await response.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600", // 1 hour cache
      },
    });
  } catch {
    return new NextResponse("Failed to fetch avatar", {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
