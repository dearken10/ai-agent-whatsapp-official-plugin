import type { Config } from "./config.ts";
import type { Buffer, BufferedMessage } from "./buffer.ts";

// transport only ever reads routingBaseUrl + routingApiKey from cfg. Narrow the
// surface area so callers like the send-wa CLI can synthesise just these two
// fields without manufacturing a fake Config.
type RoutingCfg = Pick<Config, "routingBaseUrl" | "routingApiKey">;

// Local sentinel wab: the plugin only ever talks to one WABA, so we don't
// need to track the real wab number client-side. The buffer dir uses this
// constant as the per-wab partition. WS messages from the server may include
// the real wab — we ignore it here for buffering, since flush always reads
// from `LOCAL_WAB` regardless.
export const LOCAL_WAB = "_default";

export type SendOutboundResult =
  | { status: "delivered"; messageId: string }
  | { status: "queued"; localId: string; templateSent: boolean };

type SendResponse =
  | { status: "accepted"; messageId: string }
  | { status: "window_closed"; templateSent?: boolean }
  | { error?: string };

async function postSend(
  cfg: RoutingCfg,
  body: { toPhoneNumber: string; text?: string; mediaUrl?: string; mediaType?: string; caption?: string; fileName?: string },
): Promise<SendResponse> {
  const response = await fetch(`${cfg.routingBaseUrl}/api/v1/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.routingApiKey}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`send failed: ${response.status} ${raw}`);
  }
  try {
    return JSON.parse(raw) as SendResponse;
  } catch {
    throw new Error(`send returned non-JSON ${response.status}: ${raw}`);
  }
}

// sendOutboundText is buffer-aware. While the buffer for `to` is non-empty
// it short-circuits and enqueues directly (efficiency throttle: avoids
// round-trips that we know will be rejected). Otherwise it posts to the
// backend; on `window_closed` it enqueues the message locally.
//
// Returns the outcome so the caller can log, but never throws on window-closed
// — the agent treats `queued` as success and moves on.
export async function sendOutboundText(
  cfg: RoutingCfg,
  to: string,
  text: string,
  buffer?: Buffer,
): Promise<SendOutboundResult> {
  if (buffer && (await buffer.hasPending(LOCAL_WAB, to))) {
    const m = await buffer.enqueue({ wab: LOCAL_WAB, phone: to, kind: "text", text });
    console.log(`buffer.enqueued localId=${m.id} phone=${to} (queue non-empty)`);
    return { status: "queued", localId: m.id, templateSent: false };
  }
  const res = await postSend(cfg, { toPhoneNumber: to, text });
  if ("status" in res && res.status === "accepted") {
    return { status: "delivered", messageId: res.messageId };
  }
  if ("status" in res && res.status === "window_closed") {
    const templateSent = res.templateSent === true;
    if (buffer) {
      const m = await buffer.enqueue({ wab: LOCAL_WAB, phone: to, kind: "text", text });
      console.log(`buffer.enqueued localId=${m.id} phone=${to} templateSent=${templateSent}`);
      return { status: "queued", localId: m.id, templateSent };
    }
    // No buffer available — surface the window-closed state as a soft "queued"
    // result so the caller doesn't crash, but the message is effectively lost.
    console.warn(`window_closed for ${to} but no local buffer configured — message dropped`);
    return { status: "queued", localId: "(no-buffer)", templateSent };
  }
  throw new Error(`send returned unexpected response: ${JSON.stringify(res)}`);
}

// flushPending drains every entry in the buffer for (wab, phone) by re-posting
// them in order. Each successful send removes the entry; a window_closed
// response or transient error pauses the flush so the remaining entries
// stay queued for the next inbound trigger.
export async function flushPending(
  cfg: RoutingCfg,
  buffer: Buffer,
  wab: string,
  phone: string,
): Promise<{ delivered: number; remaining: number; stoppedReason?: string }> {
  const pending = await buffer.listPending(wab, phone);
  let delivered = 0;
  for (const m of pending) {
    try {
      const res = await postSend(cfg, sendBodyFromBuffered(m));
      if ("status" in res && res.status === "accepted") {
        await buffer.markDelivered(wab, phone, m.id);
        delivered += 1;
        console.log(`buffer.flushed localId=${m.id} phone=${phone} outcome=delivered`);
        continue;
      }
      if ("status" in res && res.status === "window_closed") {
        return { delivered, remaining: pending.length - delivered, stoppedReason: "window_closed" };
      }
      throw new Error(`unexpected flush response: ${JSON.stringify(res)}`);
    } catch (err) {
      await buffer.recordFailure(wab, phone, m.id, String(err));
      console.warn(`buffer.flush_failed localId=${m.id} phone=${phone} err=${String(err)}`);
      return { delivered, remaining: pending.length - delivered, stoppedReason: "error" };
    }
  }
  return { delivered, remaining: 0 };
}

function sendBodyFromBuffered(m: BufferedMessage): {
  toPhoneNumber: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  caption?: string;
  fileName?: string;
} {
  if (m.kind === "text") return { toPhoneNumber: m.phone, text: m.text ?? "" };
  return {
    toPhoneNumber: m.phone,
    mediaUrl: m.mediaUrl ?? "",
    mediaType: m.mediaType,
    caption: m.caption,
    fileName: m.fileName,
  };
}

export async function sendTypingIndicator(cfg: RoutingCfg, messageId: string): Promise<void> {
  await fetch(`${cfg.routingBaseUrl}/api/v1/typing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.routingApiKey}`,
    },
    body: JSON.stringify({ messageId }),
  }).catch(() => undefined);
}

// WhatsApp Cloud API typing indicator auto-dismisses after ~25 seconds,
// or when the business sends a message. Refresh every 20 s so it stays
// visible across long Claude turns. Caller MUST `await stop()` — it
// awaits ALL in-flight pings so the next send isn't racing a typing call
// (the race causes post-message "typing…" that lingers 25 s).
//
// .ping() lets callers fire a one-shot typing refresh in addition to the
// recurring schedule — useful right after sending an intermediate message,
// to bring the indicator back as quickly as possible.
const TYPING_REFRESH_MS = 26_000;

export function startTypingHeartbeat(
  cfg: RoutingCfg,
  messageId: string,
): { ping: () => void; stop: () => Promise<void> } {
  let stopped = false;
  const pings: Promise<unknown>[] = [];
  const ping = (): void => {
    if (stopped) return;
    pings.push(sendTypingIndicator(cfg, messageId).catch(() => undefined));
  };
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return {
    ping,
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled(pings);
    },
  };
}

export async function fetchMedia(
  cfg: RoutingCfg,
  mediaId: string,
  directUrl?: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  const path = `${cfg.routingBaseUrl}/api/v1/media/${encodeURIComponent(mediaId)}`;
  const url = directUrl ? `${path}?url=${encodeURIComponent(directUrl)}` : path;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${cfg.routingApiKey}` } });
  if (!response.ok) throw new Error(`media fetch failed: ${response.status}`);
  const mimeType = response.headers.get("Content-Type") ?? "application/octet-stream";
  const data = new Uint8Array(await response.arrayBuffer());
  return { data, mimeType };
}
