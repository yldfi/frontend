import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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
  metadataBase: new URL("https://yld_fi.co"),
  title: "yld_fi - Automated Yield Optimization",
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
    title: "yld_fi - Automated Yield Optimization",
    description: "Optimized yield vaults with auto-compounding strategies",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "yld_fi - Automated Yield Optimization",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "yld_fi - Automated Yield Optimization",
    description: "Optimized yield vaults with auto-compounding strategies",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrainsMono.variable} min-h-screen`}>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
