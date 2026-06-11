import Image from "next/image";
import {
  fetchWeeklyApyVaults,
  formatSocialDate,
  parseSocialDate,
} from "@/lib/weekly-apy-social";
import styles from "./weekly-apy.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface WeeklyApyPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WeeklyApyPage({ searchParams }: WeeklyApyPageProps) {
  const params = await searchParams;
  const vaults = await fetchWeeklyApyVaults();
  const dateValue = parseSocialDate(params?.date);
  const displayDate = formatSocialDate(dateValue);
  const isoDate = dateValue.toISOString().slice(0, 10);

  return (
    <main className={`${styles.card} weekly-apy-card`}>
      <header className={styles.topline}>
        <div className={styles.brandLockup}>
          <Image src="/logo-128.png" alt="" width={58} height={58} priority />
          <div>
            <span className={styles.brandWord}>yld</span>
            <span className={styles.brandTagline}>Automated yield optimization</span>
          </div>
        </div>
        <time className={styles.date} dateTime={isoDate}>
          {displayDate}
        </time>
      </header>

      <section className={styles.hero}>
        <h1>
          <span>Vault</span>
          <em>weekly</em>
          <span>yields.</span>
        </h1>
      </section>

      <section className={`${styles.vaultGrid} ${vaults.length === 2 ? styles.vaultGridTwo : ""}`} aria-label="Vault weekly APYs">
        {vaults.map((vault) => (
          <article key={vault.address}>
            <Image className={styles.vaultIcon} src={vault.icon} alt="" width={86} height={86} priority />
            <div>
              <span className={styles.vaultSymbol}>
                <span>{vault.symbolPrefix}</span>
                {vault.symbolSuffix}
              </span>
              <strong>{vault.weeklyApyFormatted}</strong>
            </div>
            <em>
              <span className={styles.protocolLabel}>
                <Image src={vault.protocolLogo} alt="" width={18} height={18} />
                {vault.label}
              </span>
              <span className={styles.tokenSymbol}>{vault.underlying}</span>
            </em>
          </article>
        ))}
      </section>

      <footer className={styles.bottomline}>
        <strong>yldfi.co</strong>
      </footer>
    </main>
  );
}
