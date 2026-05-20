import type { Config } from "./config.ts";

export async function sendOutboundText(cfg: Config, to: string, text: string): Promise<void> {
  const response = await fetch(`${cfg.routingBaseUrl}/api/v1/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.routingApiKey}`,
    },
    body: JSON.stringify({ toPhoneNumber: to, text }),
  });
  if (!response.ok) {
    throw new Error(`send failed: ${response.status} ${await response.text()}`);
  }
}

export async function sendTypingIndicator(cfg: Config, messageId: string): Promise<void> {
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
  cfg: Config,
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
  cfg: Config,
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
