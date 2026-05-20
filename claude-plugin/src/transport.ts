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
// visible across long Claude turns. Caller invokes stop() when done.
const TYPING_REFRESH_MS = 20_000;

export function startTypingHeartbeat(
  cfg: Config,
  messageId: string,
): { stop: () => void } {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    sendTypingIndicator(cfg, messageId).catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, TYPING_REFRESH_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
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
