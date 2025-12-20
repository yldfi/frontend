import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Countries to block for regulatory compliance
// Includes: UK/US/CA (regulatory) + OFAC comprehensively sanctioned countries
const BLOCKED_COUNTRIES = new Set([
  // Regulatory restrictions
  "GB", // United Kingdom
  "US", // United States
  "CA", // Canada
  // OFAC comprehensively sanctioned
  "KP", // North Korea
  "IR", // Iran
  "SY", // Syria
  "CU", // Cuba
  "RU", // Russia
  // Additional OFAC sanctions
  "AF", // Afghanistan
  "BY", // Belarus
  "MM", // Myanmar (Burma)
  "VE", // Venezuela
  "ZW", // Zimbabwe
  "CD", // Democratic Republic of Congo
  "SD", // Sudan
  "SS", // South Sudan
]);

// EEA (European Economic Area) countries - require cookie consent under GDPR
const EEA_COUNTRIES = new Set([
  "AT", // Austria
  "BE", // Belgium
  "BG", // Bulgaria
  "HR", // Croatia
  "CY", // Cyprus
  "CZ", // Czech Republic
  "DK", // Denmark
  "EE", // Estonia
  "FI", // Finland
  "FR", // France
  "DE", // Germany
  "GR", // Greece
  "HU", // Hungary
  "IE", // Ireland
  "IT", // Italy
  "LV", // Latvia
  "LT", // Lithuania
  "LU", // Luxembourg
  "MT", // Malta
  "NL", // Netherlands
  "PL", // Poland
  "PT", // Portugal
  "RO", // Romania
  "SK", // Slovakia
  "SI", // Slovenia
  "ES", // Spain
  "SE", // Sweden
  "IS", // Iceland
  "LI", // Liechtenstein
  "NO", // Norway
]);

// Custom HTML page for blocked users - matches webapp styling
const blockedPageHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Restricted | YLD.fi</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <style>
    :root {
      --background: #09090b;
      --foreground: #fafafa;
      --muted: #18181b;
      --muted-foreground: #a1a1aa;
      --border: #27272a;
      --accent: #f59e0b;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--background);
      color: var(--foreground);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: 1.6;
    }
    .container {
      max-width: 480px;
      text-align: center;
    }
    .logo {
      width: 64px;
      height: 64px;
      border-radius: 50%;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 32px;
    }
    .brand-text {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.25rem;
      font-weight: 500;
      margin-bottom: 0;
    }
    .brand-text span {
      color: var(--muted-foreground);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--foreground);
    }
    p {
      color: var(--muted-foreground);
      line-height: 1.6;
      margin-bottom: 12px;
      font-size: 0.9375rem;
    }
    .card {
      background: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin: 24px 0;
    }
    .card p:last-child {
      margin-bottom: 0;
    }
    .footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }
    .footer p {
      font-size: 0.75rem;
      color: var(--muted-foreground);
      margin-bottom: 0;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <img src="/logo-128.png" alt="YLD.fi" class="logo">
      <p class="brand-text">yld<span>_</span>fi</p>
    </div>
    <h1>Access Restricted</h1>
    <div class="card">
      <p>This interface is not available in your region due to regulatory restrictions.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} YLD.fi. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

export function middleware(request: NextRequest) {
  // Get country from Cloudflare headers (available on Cloudflare Workers)
  // cf-ipcountry is set by Cloudflare for all proxied requests
  const country = request.headers.get("cf-ipcountry") || "";

  // Allow static assets to load (for better UX if someone bypasses geo-check)
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".js")
  ) {
    return NextResponse.next();
  }

  // Block restricted countries
  if (BLOCKED_COUNTRIES.has(country)) {
    return new NextResponse(blockedPageHtml, {
      status: 451, // Unavailable For Legal Reasons
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // Set EEA cookie for consent management
  const response = NextResponse.next();
  const isEEA = EEA_COUNTRIES.has(country);

  // In development, don't overwrite manually set geo_region cookie (for testing)
  const existingGeoRegion = request.cookies.get("geo_region")?.value;
  const isDev = process.env.NODE_ENV === "development";

  if (!isDev || !existingGeoRegion) {
    response.cookies.set("geo_region", isEEA ? "EEA" : "OTHER", {
      httpOnly: false, // Must be readable by JavaScript
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });
  }

  return response;
}

// Configure which paths the middleware runs on
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
