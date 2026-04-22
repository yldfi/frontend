import Link from "next/link";
import { BookOpen, Github, Send, Zap } from "lucide-react";
import { Logo } from "@/components/Logo";
import { trackExternalLinkClick } from "@/lib/analytics";

function MaskedIcon({
  src,
  className = "",
}: {
  src: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center ${className}`}
    >
      <span
        className="block h-[15px] w-[15px] bg-current"
        style={{
          WebkitMask: `url(${src}) center / contain no-repeat`,
          mask: `url(${src}) center / contain no-repeat`,
        }}
      />
    </span>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-[var(--border)]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <Logo size={32} />
            <div>
              <p className="mono text-lg font-medium mb-1">yld</p>
              <p className="text-sm text-[var(--muted-foreground)]">
                Automated yield optimization
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link
              href="/zap"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Zap"
            >
              <Zap size={18} aria-hidden="true" />
            </Link>
            <a
              href="https://defillama.com/protocol/yld"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackExternalLinkClick("https://defillama.com/protocol/yld", "defillama")}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="DefiLlama"
            >
              <MaskedIcon src="/icons/defillama.svg" className="-translate-y-px" />
            </a>
            <a
              href="https://yldfi.gitbook.io/docs"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackExternalLinkClick("https://yldfi.gitbook.io/docs", "docs")}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Documentation"
            >
              <BookOpen size={18} aria-hidden="true" />
            </a>
            <a
              href="https://github.com/yldfi"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackExternalLinkClick("https://github.com/yldfi", "github")}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="GitHub"
            >
              <Github size={18} aria-hidden="true" />
            </a>
            <a
              href="https://x.com/yld_fi"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackExternalLinkClick("https://x.com/yld_fi", "twitter")}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="X (Twitter)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://t.me/yld_official"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackExternalLinkClick("https://t.me/yld_official", "telegram")}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Telegram"
            >
              <Send size={18} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-[var(--border)] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-xs text-[var(--muted-foreground)]">
            &copy; {new Date().getFullYear()} yld. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a
              href="/terms"
              className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
            >
              Terms of Service
            </a>
            <a
              href="/privacy"
              className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
            >
              Privacy Policy
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
