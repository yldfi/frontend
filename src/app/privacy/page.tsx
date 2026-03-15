import { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Privacy Policy | yld",
  description: "Privacy Policy for yld",
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
              alt="yld"
              width={32}
              height={32}
              className="rounded-full"
            />
            <span className="mono text-lg font-medium">
              yld
            </span>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-semibold mb-2">Privacy Policy</h1>
        <p className="text-[var(--muted-foreground)] mb-8">
          Last updated: March 2026
        </p>

        <div className="space-y-8">
          {/* Introduction */}
          <section>
            <h2 className="text-xl font-medium mb-4">1. Introduction</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              yld (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to protecting your privacy.
              This Privacy Policy explains how we collect, use, and safeguard information when you use our web interface (the &quot;interface&quot;).
              The data controller for the purposes of applicable data protection law is yld, contactable at contact@yldfi.co.
            </p>
          </section>

          {/* Information We Collect */}
          <section>
            <h2 className="text-xl font-medium mb-4">2. Information We Collect</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              We collect a limited amount of information automatically to secure and improve our interface. We do not collect personal information that directly identifies you unless you voluntarily provide it (e.g., by contacting us).
            </p>

            <h3 className="text-lg font-medium mb-3 mt-6">Blockchain Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              When you connect your wallet and interact with smart contracts through our interface, your wallet address
              and transaction data are recorded on the public Ethereum blockchain. This data is publicly accessible
              and not controlled by yld.
            </p>

            <h3 className="text-lg font-medium mb-3 mt-6">Analytics Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              We use Google Analytics with Google Consent Mode v2 to understand how visitors use our interface. Based on your consent choices provided via our cookie banner, this service may collect:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4 mb-4">
              <li>Anonymized or pseudonymous identifiers (if consent is given)</li>
              <li>Pages visited and interaction events (e.g., button clicks)</li>
              <li>Device type, browser, and operating system</li>
              <li>Approximate geographic location (country/region level)</li>
              <li>Referral sources</li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              If you do not consent to analytics cookies, we only receive aggregated, non-identifying data for basic service measurement.
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

            <h3 className="text-lg font-medium mb-3 mt-6">Third-Party API Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              To provide certain features, we interact with third-party APIs. This may involve sharing your wallet address and/or transaction intent:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li><b>Enso Finance:</b> For &quot;zap&quot; functionality, we send your desired swap and deposit details (e.g., token addresses and amounts) to Enso&apos;s API to construct the transaction.</li>
              <li><b>Merkl:</b> To determine your eligibility for and allow you to claim rewards, your wallet address is used to query the Merkl rewards system.</li>
            </ul>

            <h3 className="text-lg font-medium mb-3 mt-6">Transaction Simulation Data</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              When you initiate a complex transaction, we may simulate it server-side to detect failures before
              on-chain submission. This can include your wallet address, transaction calldata, and related
              metadata processed by our transaction simulation provider (Tenderly). This data is used only
              to validate execution and improve reliability.
            </p>
          </section>

          {/* Information We Don't Collect */}
          <section>
            <h2 className="text-xl font-medium mb-4">3. Information We Do Not Collect</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              yld does not collect, store, or have access to:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>Your private keys or seed phrases</li>
              <li>Personal identification information (name, email, phone) unless you contact us directly</li>
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
              <li>Provide, maintain, and improve the functionality and user experience of our interface</li>
              <li>Analyze usage patterns to guide development priorities</li>
              <li>Ensure security, prevent abuse, and protect against malicious activity</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          {/* Legal Basis for Processing */}
          <section>
            <h2 className="text-xl font-medium mb-4">5. Legal Basis for Processing</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              For users in the European Economic Area (EEA), we process your data under the following legal bases as defined by the General Data Protection Regulation (GDPR):
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-2 ml-4">
              <li>
                <b>Consent:</b> We rely on your explicit consent, collected via our cookie consent banner, to process non-essential analytics data. You can withdraw your consent at any time.
              </li>
              <li>
                <b>Legitimate Interest:</b> We process certain technical data (e.g., from Cloudflare logs and transaction simulations) for the legitimate interests of securing our interface, preventing fraud, and ensuring its performance and reliability.
              </li>
            </ul>
          </section>

          {/* Cookies and Local Storage */}
          <section>
            <h2 className="text-xl font-medium mb-4">6. Cookies and Local Storage</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              A cookie is a small file placed on your device. We use cookies, local storage, and similar technologies for the following purposes:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-2 ml-4">
              <li>
                <b>Essential:</b> These are necessary for the site to function and cannot be switched off. They include preferences such as your choice regarding analytics consent.
              </li>
              <li>
                <b>Analytics:</b> These are optional and are used to collect information about how you interact with our website. We use this information to improve our interface.
              </li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed mt-4">
              You can manage your cookie preferences at any time through our cookie consent banner. Disabling analytics cookies will not prevent you from using our core interface features.
            </p>
          </section>

          {/* Third-Party Services */}
          <section>
            <h2 className="text-xl font-medium mb-4">7. Third-Party Services</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              Our interface integrates with third-party services that have their own privacy policies. We do not control these third parties.
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>
                <strong>Wallet Providers</strong> (e.g., RainbowKit, WalletConnect, MetaMask) - governed by their respective privacy policies
              </li>
              <li>
                <strong>Cloudflare</strong> - infrastructure and security services
              </li>
              <li>
                <strong>Enso</strong> - API for transaction construction and quoting
              </li>
              <li>
                <strong>Merkl</strong> - API for rewards distribution
              </li>
              <li>
                <strong>Tenderly</strong> - server-side transaction simulation
              </li>
              <li>
                <strong>RPC Providers</strong> (public Ethereum RPC endpoints) - used to read chain data
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
            <h2 className="text-xl font-medium mb-4">8. Data Retention</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Analytics data collected via Google Analytics is configured to be automatically retained for 14 months before deletion. Cloudflare logs are retained according to their data retention policies. We do not store transaction simulation results on our servers. Blockchain data is permanent and immutable by nature.
            </p>
          </section>

          {/* Your Rights */}
          <section>
            <h2 className="text-xl font-medium mb-4">9. Your Rights</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              Depending on your jurisdiction (e.g., the EEA under GDPR), you may have the following rights regarding your personal information:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>The right to access the data we hold about you.</li>
              <li>The right to rectify inaccurate information.</li>
              <li>The right to erasure (&quot;right to be forgotten&quot;).</li>
              <li>The right to restrict processing of your data.</li>
              <li>The right to data portability.</li>
              <li>The right to object to processing based on legitimate interests.</li>
              <li>The right to withdraw consent at any time (e.g., via the cookie consent banner).</li>
              <li>The right to lodge a complaint with a relevant supervisory authority.</li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed mt-4">
              Please note that these rights are not absolute and may be subject to legal limitations. Due to the nature of our service, most data we process is either public blockchain data (which cannot be altered) or anonymized technical data. To exercise your rights, please contact us.
            </p>
          </section>

          {/* Cross-Border Data Transfers */}
          <section>
            <h2 className="text-xl font-medium mb-4">10. Cross-Border Data Transfers</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Our service is global. The information we collect may be stored and processed in any country where our third-party service providers (like Google and Cloudflare) have facilities, including the United States. When we transfer data internationally, we rely on appropriate legal mechanisms, such as the European Commission&apos;s Standard Contractual Clauses, to ensure your data is afforded a level of protection consistent with applicable law.
            </p>
          </section>

          {/* Changes */}
          <section>
            <h2 className="text-xl font-medium mb-4">11. Changes to This Policy</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated revision date.
              Your continued use of the interface after changes constitutes acceptance of the revised policy.
            </p>
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-xl font-medium mb-4">12. Contact</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              If you have questions about this Privacy Policy, please contact us at{" "}
              <a
                href="mailto:contact@yldfi.co"
                className="text-[var(--accent)] hover:underline"
              >
                contact@yldfi.co
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
            &larr; Back to yld
          </Link>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--border)] mt-12">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <p className="text-xs text-[var(--muted-foreground)]">
            &copy; {new Date().getFullYear()} yld. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
