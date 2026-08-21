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

// WhatsApp Cloud API caps text messages at 4096 chars. We chunk at 3500 to
// leave headroom for any provider-side prefix/suffix, and prefer breaking on
// newline boundaries so we don't split mid-sentence. Every outbound path in
// the plugin funnels through sendOutboundText, so enforcing the cap here
// guarantees no oversized payload can enter the buffer or reach the provider.
export const MAX_TEXT_CHARS = 3500;

export function chunkText(text: string, max = MAX_TEXT_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + max);
    let split = end;
    if (end < text.length) {
      const lastNl = text.lastIndexOf("\n", end);
      if (lastNl > start + max / 2) split = lastNl + 1;
    }
    chunks.push(text.slice(start, split).trim());
    start = split;
  }
  return chunks.filter((c) => c.length > 0);
}

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

// sendOutboundText is buffer-aware and chunk-aware. Text longer than
// MAX_TEXT_CHARS is split before anything else so oversized payloads
// never reach the provider (which rejects with 400 "at most 4096 chars")
// and — critically — never land in the local buffer as a poison entry
// that would wedge every subsequent flushPending.
//
// While the buffer for `to` is non-empty it short-circuits and enqueues
// directly (efficiency throttle: avoids round-trips that we know will
// be rejected, and preserves ordering vs already-queued messages).
// Otherwise it posts to the backend; on `window_closed` it enqueues the
// remaining chunks locally.
//
// Returns a single aggregate result — the last delivered chunk's messageId,
// or the first queued chunk's localId — so callers that only care about
// "did this turn's reply go out" can treat it opaquely. Never throws on
// window-closed; the agent treats `queued` as success and moves on.
export async function sendOutboundText(
  cfg: RoutingCfg,
  to: string,
  text: string,
  buffer?: Buffer,
): Promise<SendOutboundResult> {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    // Empty / whitespace-only — nothing to send. Return a synthetic "delivered"
    // so callers don't crash; no wire call is made.
    return { status: "delivered", messageId: "(empty)" };
  }

  // If the buffer already has pending entries, everything goes into the
  // buffer so we don't reorder past what's already queued for this phone.
  if (buffer && (await buffer.hasPending(LOCAL_WAB, to))) {
    let firstId: string | null = null;
    for (const chunk of chunks) {
      const m = await buffer.enqueue({ wab: LOCAL_WAB, phone: to, kind: "text", text: chunk });
      if (firstId === null) firstId = m.id;
      console.log(`buffer.enqueued localId=${m.id} phone=${to} (queue non-empty)`);
    }
    return { status: "queued", localId: firstId ?? "(none)", templateSent: false };
  }

  let lastMessageId = "";
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const res = await postSend(cfg, { toPhoneNumber: to, text: chunk });
    if ("status" in res && res.status === "accepted") {
      lastMessageId = res.messageId;
      continue;
    }
    if ("status" in res && res.status === "window_closed") {
      const templateSent = res.templateSent === true;
      // Enqueue THIS chunk and every subsequent one — no point round-tripping
      // more chunks we know will bounce with the same status.
      if (buffer) {
        let firstQueuedId = "";
        for (let j = i; j < chunks.length; j++) {
          const m = await buffer.enqueue({ wab: LOCAL_WAB, phone: to, kind: "text", text: chunks[j] });
          if (!firstQueuedId) firstQueuedId = m.id;
          console.log(`buffer.enqueued localId=${m.id} phone=${to} templateSent=${templateSent}`);
        }
        return { status: "queued", localId: firstQueuedId, templateSent };
      }
      // No buffer available — the remaining chunks are lost. Surface a soft
      // "queued" so the caller doesn't crash.
      console.warn(`window_closed for ${to} but no local buffer configured — ${chunks.length - i} chunk(s) dropped`);
      return { status: "queued", localId: "(no-buffer)", templateSent };
    }
    throw new Error(`send returned unexpected response: ${JSON.stringify(res)}`);
  }
  return { status: "delivered", messageId: lastMessageId };
}

// Maximum attempts before a buffer entry is dropped as poison. Prior
// behaviour halted the entire queue on any single failure, so one
// malformed/oversized entry (e.g. text > 4096 chars) wedged everything
// behind it. We now skip past individual hard failures and give up on an
// item once it has failed this many times.
export const MAX_FLUSH_ATTEMPTS = 3;

// flushPending drains every entry in the buffer for (wab, phone) by re-posting
// them in order. Each successful send removes the entry. A `window_closed`
// response halts the whole flush (no point trying more — the same window
// gate will reject the rest). A hard error on a single entry is recorded
// against that entry only: the loop continues past it, and once an entry
// reaches MAX_FLUSH_ATTEMPTS it is dropped so it can't wedge the queue.
export async function flushPending(
  cfg: RoutingCfg,
  buffer: Buffer,
  wab: string,
  phone: string,
): Promise<{ delivered: number; remaining: number; dropped: number; stoppedReason?: string }> {
  const pending = await buffer.listPending(wab, phone);
  let delivered = 0;
  let dropped = 0;
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
        const remaining = pending.length - delivered - dropped;
        return { delivered, remaining, dropped, stoppedReason: "window_closed" };
      }
      throw new Error(`unexpected flush response: ${JSON.stringify(res)}`);
    } catch (err) {
      const attempts = m.attempts + 1;
      if (attempts >= MAX_FLUSH_ATTEMPTS) {
        // Poison: give up on this entry so it can't hold up the rest.
        await buffer.markDelivered(wab, phone, m.id);
        dropped += 1;
        console.warn(
          `buffer.dropped localId=${m.id} phone=${phone} attempts=${attempts} err=${String(err)}`,
        );
        continue;
      }
      await buffer.recordFailure(wab, phone, m.id, String(err));
      console.warn(
        `buffer.flush_failed localId=${m.id} phone=${phone} attempts=${attempts} err=${String(err)}`,
      );
      // Skip this entry for now (it stays in the queue with bumped attempts)
      // and try the next one — a single bad entry must not block the rest.
      continue;
    }
  }
  return { delivered, remaining: pending.length - delivered - dropped, dropped };
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
