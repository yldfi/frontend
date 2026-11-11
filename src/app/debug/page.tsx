import { notFound } from "next/navigation";
import DebugPageClient from "./DebugPageClient";

// Render on demand, so the notFound() below reaches the client as a real 404
// instead of prerendered not-found content served with status 200.
export const dynamic = "force-dynamic";

/**
 * Wallet/test-network diagnostics. Available in development, and in a
 * production build only when NEXT_PUBLIC_ENABLE_DEBUG_PAGE=1 was set at
 * build time.
 */
export default function DebugPage() {
  const enabled =
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PUBLIC_ENABLE_DEBUG_PAGE === "1";
  if (!enabled) notFound();
  return <DebugPageClient />;
}
