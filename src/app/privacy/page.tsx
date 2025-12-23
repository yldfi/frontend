import { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Privacy Policy | yld_fi",
  description: "Privacy Policy for yld_fi",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--border)]">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <Link href="/" className="flex items-center gap-3">
            <Image
              src="/logo-128.png"
              alt="yld_fi"
              width={32}
              height={32}
              className="rounded-full"
            />
            <span className="mono text-lg font-medium">
              yld<span className="text-[var(--muted-foreground)]">_</span>fi
            </span>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-semibold mb-2">Privacy Policy</h1>
        <p className="text-[var(--muted-foreground)] mb-8">
          Last updated: December 2025
        </p>

        <div className="space-y-8">
          {/* Introduction */}
          <section>
            <h2 className="text-xl font-medium mb-4">1. Introduction</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              yld_fi (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to protecting your privacy.
              This Privacy Policy explains how we collect, use, and safeguard information when you use our web interface.
            </p>
          </section>

          {/* Information We Collect */}
          <section>
            <h2 className="text-xl font-medium mb-4">2. Information We Collect</h2>

            <h3 className="text-lg font-medium mb-3 mt-6">Blockchain Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              When you connect your wallet and interact with smart contracts through our interface, your wallet address
              and transaction data are recorded on the public Ethereum blockchain. This data is publicly accessible
              and not controlled by yld_fi.
            </p>

            <h3 className="text-lg font-medium mb-3 mt-6">Analytics Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              We use Google Analytics to understand how visitors use our interface. This service may collect:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4 mb-4">
              <li>Pages visited and time spent on pages</li>
              <li>Device type, browser, and operating system</li>
              <li>Approximate geographic location (country/region level)</li>
              <li>Referral sources</li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Google Analytics uses cookies to collect this information. You can opt out by using browser extensions
              or adjusting your browser settings to block cookies.
            </p>

            <h3 className="text-lg font-medium mb-3 mt-6">Infrastructure Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Our interface is hosted on Cloudflare, which automatically processes certain technical data
              for security and performance purposes, including IP addresses, request headers, and access logs.
              This data is processed in accordance with{" "}
              <a
                href="https://www.cloudflare.com/privacypolicy/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] hover:underline"
              >
                Cloudflare&apos;s Privacy Policy
              </a>.
            </p>
          </section>

          {/* Information We Don't Collect */}
          <section>
            <h2 className="text-xl font-medium mb-4">3. Information We Do Not Collect</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              yld_fi does not collect, store, or have access to:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>Your private keys or seed phrases</li>
              <li>Personal identification information (name, email, phone) unless you contact us</li>
              <li>Your funds or assets (we are a non-custodial interface)</li>
              <li>Passwords or account credentials</li>
            </ul>
          </section>

          {/* How We Use Information */}
          <section>
            <h2 className="text-xl font-medium mb-4">4. How We Use Information</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              The limited information we collect is used to:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>Improve the functionality and user experience of our interface</li>
              <li>Analyze usage patterns to guide development priorities</li>
              <li>Ensure security and prevent abuse</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          {/* Cookies */}
          <section>
            <h2 className="text-xl font-medium mb-4">5. Cookies</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              We use cookies for analytics purposes through Google Analytics. These cookies help us understand
              how visitors interact with our interface. You can control cookie preferences through your browser settings.
              Disabling cookies may affect certain functionality but will not prevent you from using our core interface features.
            </p>
          </section>

          {/* Third-Party Services */}
          <section>
            <h2 className="text-xl font-medium mb-4">6. Third-Party Services</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              Our interface integrates with third-party services that have their own privacy policies:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>
                <strong>Wallet Providers</strong> (MetaMask, WalletConnect, etc.) - governed by their respective privacy policies
              </li>
              <li>
                <strong>Cloudflare</strong> - infrastructure and security services
              </li>
              <li>
                <strong>Google Analytics</strong> - usage analytics
              </li>
              <li>
                <strong>Ethereum Network</strong> - all blockchain transactions are public and permanent
              </li>
            </ul>
          </section>

          {/* Data Retention */}
          <section>
            <h2 className="text-xl font-medium mb-4">7. Data Retention</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Analytics data is retained according to Google Analytics&apos; standard retention policies.
              Cloudflare logs are retained according to their data retention policies.
              Blockchain data is permanent and immutable by nature.
            </p>
          </section>

          {/* Your Rights */}
          <section>
            <h2 className="text-xl font-medium mb-4">8. Your Rights</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              Depending on your jurisdiction, you may have the right to:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>Request information about data we hold</li>
              <li>Request deletion of data (where technically feasible)</li>
              <li>Opt out of analytics tracking</li>
              <li>Lodge complaints with data protection authorities</li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed mt-4">
              Note that blockchain data cannot be modified or deleted due to the immutable nature of distributed ledgers.
            </p>
          </section>

          {/* Changes */}
          <section>
            <h2 className="text-xl font-medium mb-4">9. Changes to This Policy</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated revision date.
              Your continued use of the interface after changes constitutes acceptance of the revised policy.
            </p>
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-xl font-medium mb-4">10. Contact</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              If you have questions about this Privacy Policy, please contact us at{" "}
              <a
                href="mailto:contact@yld_fi.co"
                className="text-[var(--accent)] hover:underline"
              >
                contact@yld_fi.co
              </a>.
            </p>
          </section>
        </div>

        {/* Back link */}
        <div className="mt-12 pt-8 border-t border-[var(--border)]">
          <Link
            href="/"
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            &larr; Back to yld_fi
          </Link>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--border)] mt-12">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <p className="text-xs text-[var(--muted-foreground)]">
            &copy; {new Date().getFullYear()} yld_fi. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
