import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { ChannelGatewayContext, OpenClawConfig } from "openclaw/plugin-sdk";
import { handleWhatsappOfficialInbound } from "./inbound.js";
import { PLUGIN_ID } from "./constants.js";
import type { ResolvedWhatsappOfficialAccount } from "./types.js";

type WsEnvelope = {
  type: "INBOUND_MESSAGE" | "PAIRING_COMPLETE" | "HEARTBEAT" | "ERROR";
  payload: Record<string, unknown>;
  timestamp: string;
  message_id: string;
};

function wsUrlFromHttpBase(base: string): string {
  if (base.startsWith("https://")) {
    return `${base.replace("https://", "wss://")}/ws`;
  }
  return `${base.replace("http://", "ws://")}/ws`;
}

function nextBackoffMs(attempt: number): number {
  const base = Math.min(60_000, Math.pow(2, attempt) * 1_000);
  return base + Math.floor(Math.random() * 500);
}

/**
 * Long-lived gateway loop: maintains WebSocket to imBee routing server and
 * dispatches inbound text into OpenClaw using the same pattern as bundled channels.
 */
export async function startWhatsappOfficialGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedWhatsappOfficialAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`${PLUGIN_ID} is not configured for account "${account.accountId}"`);
  }
  if (!account.apiKey) {
    ctx.log?.warn(`${PLUGIN_ID}: missing apiKey; inbound WebSocket will not start`);
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      configured: true,
    });
    return;
  }

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
  });

  let attempt = 0;
  try {
    while (!ctx.abortSignal.aborted) {
      const url = wsUrlFromHttpBase(account.routingBaseUrl);
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(url, {
          headers: { Authorization: `Bearer ${account.apiKey}` },
        });

        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const finish = () => {
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
          ws.removeAllListeners();
          resolve();
        };

        ws.on("open", () => {
          attempt = 0;
          ctx.log?.info(`${PLUGIN_ID}: WebSocket connected (${url})`);
          // Send periodic pings to keep the connection alive through proxies/ngrok.
          pingTimer = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
              ws.ping();
            }
          }, 30_000);
        });

        ws.on("message", async (raw) => {
          try {
            const envelope = JSON.parse(String(raw)) as WsEnvelope;
            if (envelope.type === "PAIRING_COMPLETE") {
              ctx.log?.info(`${PLUGIN_ID}: pairing complete`);
              return;
            }
            if (envelope.type !== "INBOUND_MESSAGE") {
              return;
            }
            const from = String(envelope.payload.from ?? "");
            const text = String(envelope.payload.text ?? "");
            const messageId = envelope.message_id || String(envelope.payload.messageId ?? "");
            const mediaId = String(envelope.payload.mediaId ?? "");
            const mediaUrl = String(envelope.payload.mediaUrl ?? "");
            const mediaType = String(envelope.payload.mediaType ?? "");
            const mimeType = String(envelope.payload.mimeType ?? "");
            const caption = String(envelope.payload.caption ?? "");
            const fileName = String(envelope.payload.fileName ?? "");
            if (!from || (!text && !mediaId)) {
              return;
            }
            await handleWhatsappOfficialInbound({
              channelLabel: "Official WhatsApp (imBee)",
              account,
              cfg: ctx.cfg as OpenClawConfig,
              from,
              text,
              messageId,
              mediaId,
              mediaUrl,
              mediaType,
              mimeType,
              caption,
              fileName,
            });
          } catch (error) {
            ctx.log?.error(`${PLUGIN_ID}: inbound handling error: ${String(error)}`);
          }
        });

        ws.on("close", finish);
        ws.on("error", (err) => {
          ctx.log?.warn(`${PLUGIN_ID}: WebSocket error: ${String(err)}`);
          finish();
        });

        const onAbort = () => {
          ws.close();
        };
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      });

      if (ctx.abortSignal.aborted) {
        break;
      }
      const waitMs = nextBackoffMs(++attempt);
      try {
        await delay(waitMs, undefined, { signal: ctx.abortSignal });
      } catch {
        break;
      }
    }
  } finally {
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
    });
  }
}
