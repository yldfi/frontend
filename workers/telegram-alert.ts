/**
 * Best-effort Telegram message for worker alerts (tracker 386). Never throws,
 * so it can't mask the error being reported, and gives up after 5 s. A no-op
 * unless both secrets are set.
 */
export interface TelegramAlertEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export async function notifyTelegram(
  env: TelegramAlertEnv,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error("telegram alert failed", res.status);
    return res.ok;
  } catch (error) {
    console.error("telegram alert failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}
