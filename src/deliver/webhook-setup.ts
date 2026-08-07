import "../lib/env.js";

// One-shot webhook registration:
//   npm run webhook -- https://<project>.vercel.app/api/telegram
//   npm run webhook -- --delete        (revert to getUpdates polling)
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env. Telegram
// sends the secret with every webhook call; api/telegram.ts rejects anything
// without it.

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const api = (m: string) => `https://api.telegram.org/bot${token}/${m}`;

async function call(method: string, body: object): Promise<unknown> {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

async function main() {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const arg = process.argv[2];
  if (!arg) throw new Error("Usage: npm run webhook -- <https-url> | --delete");

  if (arg === "--delete") {
    await call("deleteWebhook", { drop_pending_updates: false });
    console.log("Webhook deleted — getUpdates polling active again.");
  } else {
    if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not set — add a random string to .env");
    if (!arg.startsWith("https://")) throw new Error("Webhook URL must be https");
    await call("setWebhook", {
      url: arg,
      secret_token: secret,
      allowed_updates: ["callback_query"],
      drop_pending_updates: false,
    });
    console.log(`Webhook set to ${arg}`);
  }
  console.log("getWebhookInfo:", JSON.stringify(await call("getWebhookInfo", {}), null, 2));
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
