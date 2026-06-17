// One-shot CLI for pushing a WhatsApp message from inside a Claude Code
// workspace (skills, cron jobs, async scripts). Invoked via the `send-wa`
// shim in workspace-template/. Re-uses the plugin's buffer so a send that
// hits the 24-hour window gets persisted to disk and flushed automatically
// the next time the user replies on WhatsApp.
//
// Env (exported into the workspace by claude-session.ts:claudeEnv):
//   ROUTING_BASE_URL       (required)
//   ROUTING_API_KEY        (required)
//   USER_PHONE             (required — also the only legal toPhoneNumber)
//   WA_BUFFER_DIR          (optional; without it, window_closed sends are lost)
//   WA_BUFFER_MAX_PER_PHONE, WA_BUFFER_TTL_HOURS (optional)
//
// Exit codes:
//   0 — delivered (.messageId logged)
//   2 — queued locally (window_closed; flushes on next inbound)
//   1 — hard failure (bad config, network error, unexpected response)

import { Buffer } from "../buffer.ts";
import { sendOutboundText } from "../transport.ts";

function envOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error("usage: send-wa <text>");
  process.exit(64);
}

const routingBaseUrl = process.env.ROUTING_BASE_URL?.trim();
const routingApiKey = process.env.ROUTING_API_KEY?.trim();
const userPhone = process.env.USER_PHONE?.trim();
if (!routingBaseUrl || !routingApiKey || !userPhone) {
  console.error("send-wa: missing ROUTING_BASE_URL, ROUTING_API_KEY, or USER_PHONE in env");
  process.exit(1);
}

const bufferDir = process.env.WA_BUFFER_DIR?.trim();
const buffer = bufferDir
  ? new Buffer({
      dir: bufferDir,
      maxPerPhone: envOr("WA_BUFFER_MAX_PER_PHONE", 50),
      ttlMs: envOr("WA_BUFFER_TTL_HOURS", 72) * 3600_000,
    })
  : undefined;

try {
  const result = await sendOutboundText(
    { routingBaseUrl, routingApiKey },
    userPhone,
    text,
    buffer,
  );
  if (result.status === "delivered") {
    console.log(`delivered messageId=${result.messageId}`);
    process.exit(0);
  }
  console.error(
    `queued (window_closed) localId=${result.localId} templateSent=${result.templateSent}`,
  );
  process.exit(2);
} catch (err) {
  console.error(`send-wa: ${(err as Error).message ?? String(err)}`);
  process.exit(1);
}
