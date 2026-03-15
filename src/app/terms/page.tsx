import { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Terms of Service | yld",
  description: "Terms of Service and restricted jurisdictions for yld",
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
        <h1 className="text-3xl font-semibold mb-2">Terms of Service</h1>
        <p className="text-[var(--muted-foreground)] mb-8">
          Last updated: March 2026
        </p>

        <div className="space-y-8">
          {/* Introduction */}
          <section>
            <h2 className="text-xl font-medium mb-4">1. Introduction</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Welcome to yld.fi (the &quot;interface&quot;). By accessing or using our interface, you agree to be bound by these Terms of Service (&quot;Terms&quot;).
              The interface provides access to a decentralized finance protocol on the Ethereum blockchain (the &quot;Protocol&quot;) that includes, but is not limited to, yield-generating vaults, borrowing/lending, and token swaps.
              The interface is a tool to help you interact with the Protocol and is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind.
            </p>
          </section>

          {/* The yld Protocol */}
          <section>
            <h2 className="text-xl font-medium mb-4">2. The yld Protocol</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              The yld interface provides access to the following features, which are enabled by smart contracts and integrations with third-party protocols:
            </p>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              yld has deployed certain smart contracts (vaults and strategies) to the Ethereum blockchain. These vault and strategy contracts are immutable and cannot be modified, paused, or upgraded by anyone, including yld. yld also deployed the price oracle used by the ycvxCRV LlamaLend market, which can be changed by the Curve DAO through governance. The LlamaLend lending market itself is operated by Curve&apos;s protocol. yld does not custody user assets and does not control the Ethereum network or third-party protocols.
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-2 ml-4">
              <li>
                <b>Yield Vaults:</b> You may deposit digital assets into ERC-4626 compliant vaults to earn auto-compounded yield.
              </li>
              <li>
                <b>Lending and Borrowing:</b> You may use your vault tokens as collateral to borrow crvUSD through an integration with Curve&apos;s LlamaLend protocol.
              </li>
              <li>
                <b>Zap & Swap Functionality:</b> You may perform combination transactions, such as swapping and depositing in a single step, using an API provided by Enso.
              </li>
              <li>
                <b>Rewards Program:</b> Eligible users may earn and claim crvUSD rewards for certain borrowing activities through the Merkl protocol.
              </li>
            </ul>
          </section>

          {/* Restricted Jurisdictions */}
          <section>
            <h2 className="text-xl font-medium mb-4">3. Restricted Jurisdictions</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              yld is not available to persons or entities located in, incorporated in, or residents of certain restricted jurisdictions.
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
            <h2 className="text-xl font-medium mb-4">4. Eligibility</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              By using yld, you represent and warrant that you are at least 18 years of age or the age of legal majority in your jurisdiction, whichever is greater.
              You further represent that you are not located in, incorporated in, or a resident of any restricted jurisdiction listed above,
              and that you are not on any sanctions list maintained by OFAC or other relevant authorities.
              Your use of this interface must comply with all applicable laws and regulations in your jurisdiction.
            </p>
          </section>

          {/* Prohibited Activities */}
          <section>
            <h2 className="text-xl font-medium mb-4">5. Prohibited Activities</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              By using yld, you agree not to engage in any of the following prohibited activities:
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
            <h2 className="text-xl font-medium mb-4">6. Interface and Protocol Disclaimer</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              This web application is provided as a tool for users to interact with the Protocol on their own initiative. By using this interface, you acknowledge that you are accessing
              blockchain smart contracts directly, without any intermediary, custodian, or fiduciary involvement from the contributors to yld.
              We do not endorse or recommend any specific assets or transactions.
            </p>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              yld is a frontend interface only. It does not hold, control, or have access to your assets at any time. All transactions are executed directly on the blockchain via your connected wallet (e.g., via RainbowKit/WalletConnect). You maintain sole custody and control of your funds.
            </p>
          </section>

          {/* Assumption of Risk */}
          <section>
            <h2 className="text-xl font-medium mb-4">7. Assumption of Risk</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              Your use of the Protocol and interface is entirely at your own risk. You acknowledge and accept the significant risks associated with decentralized finance, including but not limited to the following:
            </p>
            <ul className="list-disc list-inside text-[var(--muted-foreground)] space-y-3 ml-4">
              <li>
                <b>Smart Contract Risk:</b> The Protocol involves complex smart contracts. Despite audits, there is a risk of vulnerabilities, bugs, or exploits that could lead to a partial or total loss of your funds. All transactions are irreversible.
              </li>
              <li>
                <b>Lending and Liquidation Risk:</b> When you borrow assets, the value of your collateral may fluctuate. If your collateral value falls below a certain threshold, your position may be subject to liquidation, meaning your collateral will be sold to repay your debt, potentially at a loss. The LlamaLend protocol uses a &quot;soft-liquidation&quot; mechanism, which you are responsible for understanding.
              </li>
              <li>
                <b>Third-Party Protocol Risk:</b> The interface integrates with third-party protocols such as Curve, Enso, and Merkl. These are independent systems outside of our control. Any failure, exploit, or adverse event on these protocols could negatively impact your funds or rewards.
              </li>
              <li>
                <b>Price Oracle Risk:</b> The lending functionality relies on price oracles to determine the value of your collateral. yld deployed the oracle used by the ycvxCRV LlamaLend market; however, the oracle contract can be changed by the Curve DAO through governance. Oracles may report incorrect prices or be subject to manipulation, which could lead to premature liquidations or other unintended outcomes.
              </li>
              <li>
                <b>Impermanent Loss:</b> Certain DeFi strategies, particularly those involving liquidity pools, may expose you to impermanent loss, where the value of your deposited assets diverges from what their value would have been if you had simply held them.
              </li>
              <li>
                <b>Gas Fees and Network Risk:</b> All transactions on the Ethereum network require the payment of gas fees. Network congestion can cause these fees to become very high. Failed transactions will still incur gas fees.
              </li>
              <li>
                <b>MEV and Frontrunning:</b> Your transactions may be inspected and reordered by network participants (MEV or &quot;Maximal Extractable Value&quot;), which could result in front-running or other forms of transaction manipulation leading to unfavorable execution prices.
              </li>
              <li>
                <b>Regulatory Uncertainty:</b> The legal and regulatory landscape for digital assets and DeFi is uncertain. Changes in laws could adversely affect the Protocol or your ability to use it.
              </li>
            </ul>
            <p className="text-[var(--muted-foreground)] leading-relaxed mt-4">
              yld does not provide financial, investment, legal, or tax advice. You must conduct your own research and consult with appropriate professionals.
            </p>
          </section>

          {/* No Warranties */}
          <section>
            <h2 className="text-xl font-medium mb-4">8. No Warranties</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              The interface and the Protocol are provided on an &quot;as is&quot; and &quot;as available&quot; basis without warranties of any kind,
              either express or implied. We do not guarantee that the interface will be uninterrupted, secure, or error-free, nor do we warrant the results that may be obtained from its use.
              Your use of the interface and Protocol is at your own risk.
            </p>
          </section>

          {/* Limitation of Liability */}
          <section>
            <h2 className="text-xl font-medium mb-4">9. Limitation of Liability</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              To the maximum extent permitted by law, yld and its contributors shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages, or any loss of profits or revenues,
              whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses, resulting from (a) your access to or use of or inability to access or use the interface or Protocol; (b) any conduct or content of any third party on the service; or (c) unauthorized access, use, or alteration of your transmissions or content.
            </p>
          </section>

          {/* Intellectual Property */}
          <section>
            <h2 className="text-xl font-medium mb-4">10. Intellectual Property</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              We grant you a limited, non-exclusive, non-transferable, revocable license to access and use the yld interface for its intended purposes. The &quot;yld&quot; name, logo, and other related graphics, as well as the source code for the interface, are the property of the yld contributors and are protected by copyright, trademark, and other intellectual property laws.
            </p>
          </section>

          {/* Indemnification */}
          <section>
            <h2 className="text-xl font-medium mb-4">11. Indemnification</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              You agree to indemnify and hold harmless yld and its contributors from and against any claims, damages, losses, liabilities, and expenses (including reasonable legal fees) arising out of or in connection with your use of the interface or the Protocol, your violation of these Terms, or your violation of any rights of any other person or entity.
            </p>
          </section>

          {/* Privacy Policy */}
          <section>
            <h2 className="text-xl font-medium mb-4">12. Privacy Policy</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Your use of yld is also governed by our{" "}
              <Link href="/privacy" className="text-[var(--accent)] hover:underline">
                Privacy Policy
              </Link>, which describes how we collect, use, and protect your information.
              By using the interface, you consent to the practices described in our Privacy Policy.
            </p>
          </section>

          {/* Governing Law and Dispute Resolution */}
          <section>
            <h2 className="text-xl font-medium mb-4">13. Governing Law and Dispute Resolution</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed mb-4">
              These Terms shall be governed by and construed in accordance with the laws of England and Wales, without regard to its conflict of law principles.
            </p>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              Any dispute, controversy, or claim arising out of or in relation to these Terms, including the validity, invalidity, breach, or termination thereof, shall be resolved by binding arbitration. The number of arbitrators shall be one. The seat of the arbitration shall be London, England. The language of the arbitration shall be English.
            </p>
          </section>

          {/* Changes */}
          <section>
            <h2 className="text-xl font-medium mb-4">14. Changes to Terms</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              We reserve the right to modify these terms at any time. Changes will be effective immediately upon posting.
              Your continued use of the interface after changes constitutes acceptance of the modified terms. We encourage you to review the Terms periodically.
            </p>
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-xl font-medium mb-4">15. Contact</h2>
            <p className="text-[var(--muted-foreground)] leading-relaxed">
              If you have questions about these Terms of Service or believe you are seeing a restricted access message in error,
              please contact us at{" "}
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
