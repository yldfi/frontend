import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      {/* Header */}
      <header className="border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="mono text-lg font-medium tracking-tight leading-none">
              yld<span className="text-[var(--muted-foreground)]">_</span>fi
            </span>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-6 px-6">
          <h1 className="text-6xl font-bold mono">404</h1>
          <p className="text-xl text-[var(--muted-foreground)]">
            Page not found
          </p>
          <p className="text-[var(--muted-foreground)] max-w-md">
            The vault or page you&apos;re looking for doesn&apos;t exist or may have been moved.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--foreground)] text-[var(--background)] rounded-lg font-medium hover:opacity-90 transition-colors"
          >
            Back to Home
          </Link>
        </div>
      </main>
    </div>
  );
}
