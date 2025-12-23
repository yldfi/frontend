import { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Terms of Service | yld_fi",
  description: "Terms of Service and restricted jurisdictions for yld_fi",
};

export default function TermsPage() {
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
        <h1 className="text-3xl font-semibold mb-2">Terms of Service</h1>
        <p className="text-[var(--muted-foreground)] mb-8">
          Last updated: December 2025
        </p>

        <div className="space-y-8">
          {/* Introduction */}
          <section>
            <h2 className="text-xl font-medium mb-4">1. Introduction</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Welcome to yld_fi. By accessing or using our interface, you agree to be bound by these Terms of Service.
              yld_fi provides a web interface for interacting with Yearn V3 vaults and related smart contracts on Ethereum.
              The interface is provided &quot;as is&quot; without warranties of any kind.
            </p>
          </section>

          {/* Restricted Jurisdictions */}
          <section>
            <h2 className="text-xl font-medium mb-4">2. Restricted Jurisdictions</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              yld_fi is not available to persons or entities located in, incorporated in, or residents of certain restricted jurisdictions.
              By geo-blocking users from these regions, we ensure compliance with applicable laws and regulations.
            </p>

            <h3 className="text-lg font-medium mb-3 mt-6">Regulatory Restrictions</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-3">
              The following jurisdictions are restricted due to regulatory requirements:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>United Kingdom (UK)</li>
              <li>United States (US)</li>
              <li>Canada (CA)</li>
            </ul>

            <h3 className="text-lg font-medium mb-3 mt-6">OFAC Sanctioned Countries</h3>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-3">
              In compliance with U.S. Office of Foreign Assets Control (OFAC) sanctions, the following countries are restricted:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-1 ml-4">
              <li>North Korea (KP)</li>
              <li>Iran (IR)</li>
              <li>Syria (SY)</li>
              <li>Cuba (CU)</li>
              <li>Russia (RU)</li>
              <li>Afghanistan (AF)</li>
              <li>Belarus (BY)</li>
              <li>Myanmar / Burma (MM)</li>
              <li>Venezuela (VE)</li>
              <li>Zimbabwe (ZW)</li>
              <li>Democratic Republic of Congo (CD)</li>
              <li>Sudan (SD)</li>
              <li>South Sudan (SS)</li>
            </ul>
          </section>

          {/* Eligibility */}
          <section>
            <h2 className="text-xl font-medium mb-4">3. Eligibility</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              By using yld_fi, you represent and warrant that you are not located in, incorporated in, or a resident of any restricted jurisdiction listed above,
              and that you are not on any sanctions list maintained by OFAC or other relevant authorities.
              You further represent that your use of this interface complies with all applicable laws and regulations in your jurisdiction.
            </p>
          </section>

          {/* Prohibited Activities */}
          <section>
            <h2 className="text-xl font-medium mb-4">4. Prohibited Activities</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              By using yld_fi, you agree not to engage in any of the following prohibited activities:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-2 ml-4">
              <li>Using the interface for any illegal activities, including money laundering, terrorist financing, or fraud</li>
              <li>Attempting to gain unauthorized access to the interface, other users&apos; wallets, or any connected systems</li>
              <li>Introducing malicious code, viruses, or any harmful software</li>
              <li>Interfering with or disrupting the normal operation of the interface</li>
              <li>Using automated systems, bots, or scripts to interact with the interface in a manner that could damage or overload our systems</li>
              <li>Circumventing or attempting to circumvent geo-blocking measures or other access restrictions</li>
              <li>Misrepresenting your identity, location, or affiliation</li>
              <li>Using the interface to manipulate markets or engage in wash trading</li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed mt-4">
              Violation of these terms may result in immediate termination of your access to the interface and may be reported to relevant authorities.
            </p>
          </section>

          {/* Interface Disclaimer */}
          <section>
            <h2 className="text-xl font-medium mb-4">5. Interface Disclaimer</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              This web application is provided as a tool for users to interact with smart contracts deployed on Ethereum on their own initiative,
              with no endorsement or recommendation of cryptocurrency trading activities. By using this interface, you acknowledge that you are accessing
              blockchain smart contracts directly, without any intermediary, custodian, or fiduciary involvement from yld_fi.
            </p>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              yld_fi is a frontend interface only. It does not hold, control, or have access to your assets at any time.
              All transactions are executed directly on the blockchain via your connected wallet. You maintain sole custody and control of your funds.
            </p>
          </section>

          {/* Risks */}
          <section>
            <h2 className="text-xl font-medium mb-4">6. Risks</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              DeFi protocols involve significant risks including but not limited to: smart contract vulnerabilities,
              impermanent loss, market volatility, regulatory changes, and potential loss of funds.
              You acknowledge that you understand these risks and accept full responsibility for your actions.
              yld_fi does not provide financial, investment, or legal advice.
            </p>
          </section>

          {/* No Warranties */}
          <section>
            <h2 className="text-xl font-medium mb-4">7. No Warranties</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              The interface is provided on an &quot;as is&quot; and &quot;as available&quot; basis without warranties of any kind,
              either express or implied. We do not guarantee that the interface will be uninterrupted, secure, or error-free.
              Your use of the interface is at your own risk.
            </p>
          </section>

          {/* Limitation of Liability */}
          <section>
            <h2 className="text-xl font-medium mb-4">8. Limitation of Liability</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              To the maximum extent permitted by law, yld_fi and its contributors shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages, or any loss of profits or revenues,
              whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses.
            </p>
          </section>

          {/* Privacy Policy */}
          <section>
            <h2 className="text-xl font-medium mb-4">9. Privacy Policy</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Your use of yld_fi is also governed by our{" "}
              <Link href="/privacy" className="text-[var(--accent)] hover:underline">
                Privacy Policy
              </Link>, which describes how we collect, use, and protect your information.
              By using the interface, you consent to the practices described in our Privacy Policy.
            </p>
          </section>

          {/* Changes */}
          <section>
            <h2 className="text-xl font-medium mb-4">10. Changes to Terms</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              We reserve the right to modify these terms at any time. Changes will be effective immediately upon posting.
              Your continued use of the interface after changes constitutes acceptance of the modified terms.
            </p>
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-xl font-medium mb-4">11. Contact</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              If you have questions about these Terms of Service or believe you are seeing a restricted access message in error,
              please contact us at{" "}
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
