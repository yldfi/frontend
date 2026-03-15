import Link from "next/link";
import { BookOpen, Github, Send, Gift } from "lucide-react";
import { Logo } from "@/components/Logo";

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
              href="/rewards"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Rewards"
            >
              <Gift size={18} aria-hidden="true" />
            </Link>
            <a
              href="https://yldfi.gitbook.io/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Documentation"
            >
              <BookOpen size={18} aria-hidden="true" />
            </a>
            <a
              href="https://github.com/yldfi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="GitHub"
            >
              <Github size={18} aria-hidden="true" />
            </a>
            <a
              href="https://t.me/yld_fi"
              target="_blank"
              rel="noopener noreferrer"
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
