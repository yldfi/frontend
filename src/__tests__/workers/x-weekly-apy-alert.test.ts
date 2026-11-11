// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { notifyTelegram } from "../../../workers/telegram-alert";

// Loaded dynamically: the worker relies on its own generated env types
// (workers/x-weekly-apy-env.d.ts), which the root project does not include.
const WORKER_MODULE = "../../../workers/x-weekly-apy";
type ScheduledWorker = { scheduled: (c: unknown, env: unknown, ctx: unknown) => Promise<void> };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const secrets = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "-100200300" };

describe("weekly X post failure alert (tracker 386)", () => {
  it("posts to the Telegram bot API with the chat id", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(notifyTelegram(secrets, "hello", fetchMock as unknown as typeof fetch)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: "-100200300", text: "hello" });
  });

  it("does nothing without the secrets", async () => {
    const fetchMock = vi.fn();
    await expect(notifyTelegram({}, "hello", fetchMock as unknown as typeof fetch)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws: network errors and HTTP errors return false", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(notifyTelegram(secrets, "x", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).resolves.toBe(false);
    await expect(notifyTelegram(secrets, "x", (async () => new Response("no", { status: 403 })) as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("alerts and still rethrows when the cron run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    let alertText = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).startsWith("https://api.telegram.org/")) {
        alertText = JSON.parse(String(init?.body)).text;
        expect(alertText).toMatch(/weekly APY X post failed \(2026-11-16, cron\)/);
        return new Response("{}", { status: 200 });
      }
      return new Response("render failed", { status: 500 }); // Browser Rendering fails
    }));
    const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const env = {
      ...secrets,
      SOCIAL_RUN_SECRET: "run-secret-value",
      SOCIAL_CACHE: kv,
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
      SITE_URL: "https://yldfi.co",
      SOCIAL_RENDER_PATH: "/social/weekly-apy",
      X_WEEKLY_COPY: "copy",
      X_DRY_RUN: "false",
      X_CLIENT_ID: "id",
    };
    const worker = ((await import(/* @vite-ignore */ WORKER_MODULE)) as { default: ScheduledWorker }).default;
    await expect(
      worker.scheduled({ scheduledTime: Date.parse("2026-11-16T10:00:00Z"), cron: "0 10 * * 1" }, env, {}),
    ).rejects.toThrow();
    expect(calls.some((u) => u.startsWith("https://api.telegram.org/bot123:abc/sendMessage"))).toBe(true);
    expect(alertText).toContain("/run?date=2026-11-16&post=1");
    expect(alertText).toContain("SOCIAL_RUN_SECRET");
    expect(alertText).not.toContain("run-secret-value");
    expect(alertText).not.toContain("Rerun: POST");
    expect(kv.put).toHaveBeenCalledWith("x:weekly-apy:last-run", expect.stringContaining('"ok":false'), expect.anything());
  });
});
