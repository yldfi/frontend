import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ClientProviders } from "@/components/ClientProviders";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "YLD.fi - Automated Yield Optimization",
  description:
    "Deposit into optimized ERC-4626 vaults with auto-compounding strategies.",
  keywords: ["DeFi", "yield", "vaults", "ERC-4626", "auto-compound", "crypto"],
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "YLD.fi - Automated Yield Optimization",
    description: "Optimized yield vaults with auto-compounding strategies",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "YLD.fi - Automated Yield Optimization",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "YLD.fi - Automated Yield Optimization",
    description: "Optimized yield vaults with auto-compounding strategies",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const gaId = process.env.NEXT_PUBLIC_GA_ID;

  return (
    <html lang="en" className="dark">
      <head>
        {gaId && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${gaId}');
              `}
            </Script>
          </>
        )}
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} min-h-screen`}>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
