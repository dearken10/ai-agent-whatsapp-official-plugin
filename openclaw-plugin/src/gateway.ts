import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { ChannelGatewayContext, OpenClawConfig } from "openclaw/plugin-sdk";
import { handleWhatsappOfficialInbound } from "./inbound.js";
import { PLUGIN_ID } from "./constants.js";
import type { ResolvedWhatsappOfficialAccount } from "./types.js";
import { Buffer } from "./buffer.js";
import { flushPending, LOCAL_WAB, sendOutboundText, setActiveBuffer } from "./transport.js";

type WsEnvelope = {
  type: "INBOUND_MESSAGE" | "PAIRING_COMPLETE" | "WINDOW_OPENED" | "HEARTBEAT" | "ERROR";
  payload: Record<string, unknown>;
  timestamp: string;
  message_id: string;
};

function bufferConfigFor(accountId: string): { dir: string; maxPerPhone: number; ttlMs: number } {
  const dir = process.env.WA_BUFFER_DIR ?? join(homedir(), ".openclaw-whatsapp-buffer", accountId);
  const intEnv = (k: string, def: number): number => {
    const raw = process.env[k];
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    dir,
    maxPerPhone: intEnv("WA_BUFFER_MAX_PER_PHONE", 50),
    ttlMs: intEnv("WA_BUFFER_TTL_HOURS", 72) * 3600_000,
  };
}

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

  // Initialise plugin-local outbound buffer (24h window handling).
  // Bodies live ONLY on disk under WA_BUFFER_DIR; the routing server never
  // sees buffered content again until flush. See docs/prd/24h-window-and-buffering.md.
  const buffer = new Buffer(bufferConfigFor(account.accountId));
  setActiveBuffer(buffer);
  const sweepMin = Number.parseInt(process.env.WA_BUFFER_SWEEP_INTERVAL_MIN ?? "15", 10) || 15;
  const sweeper = setInterval(() => {
    void buffer.sweepExpired().then((n) => {
      if (n > 0) ctx.log?.info(`${PLUGIN_ID}: buffer.expired removed=${n}`);
    }).catch((err) => {
      ctx.log?.warn(`${PLUGIN_ID}: buffer sweep failed: ${String(err)}`);
    });
  }, sweepMin * 60_000);
  sweeper.unref?.();

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
          // Try to drain any buffer that survived a previous session. The
          // server-side template_throttle prevents duplicate billable template
          // sends, so calling flush on a still-closed window is safe.
          void (async () => {
            try {
              const pairs = await buffer.enumeratePending();
              if (pairs.length === 0) return;
              ctx.log?.info(`${PLUGIN_ID}: startup flush ${pairs.length} pair(s)`);
              for (const { wab, phone } of pairs) {
                const r = await flushPending({ cfg: ctx.cfg as OpenClawConfig, accountId: account.accountId, buffer, wab, phone });
                ctx.log?.info(`${PLUGIN_ID}: startup flush phone=${phone} delivered=${r.delivered} remaining=${r.remaining} stopped=${r.stoppedReason ?? "ok"}`);
              }
            } catch (err) {
              ctx.log?.warn(`${PLUGIN_ID}: startup flush error: ${String(err)}`);
            }
          })();
        });

        ws.on("message", async (raw) => {
          try {
            const envelope = JSON.parse(String(raw)) as WsEnvelope;
            if (envelope.type === "PAIRING_COMPLETE") {
              const phone = String(envelope.payload.phoneNumber ?? "unknown");
              const mode = String(envelope.payload.pairingMode ?? "single_use");
              const inviteId = envelope.payload.inviteId ? ` invite=${String(envelope.payload.inviteId)}` : "";
              ctx.log?.info(`${PLUGIN_ID}: pairing complete phone=${phone} mode=${mode}${inviteId}`);
              return;
            }
            if (envelope.type === "WINDOW_OPENED") {
              const phone = String(envelope.payload.phone ?? "");
              if (!phone) return;
              ctx.log?.info(`${PLUGIN_ID}: WINDOW_OPENED phone=${phone}; flushing`);
              const r = await flushPending({ cfg: ctx.cfg as OpenClawConfig, accountId: account.accountId, buffer, wab: LOCAL_WAB, phone });
              ctx.log?.info(`${PLUGIN_ID}: flush delivered=${r.delivered} remaining=${r.remaining} stopped=${r.stoppedReason ?? "ok"}`);
              // Buffer was empty — give the user feedback so their tap isn't silently swallowed.
              if (r.delivered === 0 && r.remaining === 0) {
                try {
                  await sendOutboundText({ cfg: ctx.cfg as OpenClawConfig, accountId: account.accountId, to: phone, text: "There is no unread messages.", buffer });
                } catch (err) {
                  ctx.log?.warn(`${PLUGIN_ID}: window_opened fallback send failed phone=${phone} err=${String(err)}`);
                }
              }
              return;
            }
            if (envelope.type !== "INBOUND_MESSAGE") {
              return;
            }
            const from = String(envelope.payload.from ?? "");
            // Flush any buffered backlog BEFORE handing the inbound to the
            // agent so the user sees prior context first.
            if (from) {
              const r = await flushPending({ cfg: ctx.cfg as OpenClawConfig, accountId: account.accountId, buffer, wab: LOCAL_WAB, phone: from });
              if (r.delivered > 0) {
                ctx.log?.info(`${PLUGIN_ID}: pre-dispatch flush delivered=${r.delivered} remaining=${r.remaining}`);
              }
            }
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
              channelLabel: "WhatsApp Official API by imBee",
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
    clearInterval(sweeper);
    setActiveBuffer(undefined);
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
    });
  }
}
