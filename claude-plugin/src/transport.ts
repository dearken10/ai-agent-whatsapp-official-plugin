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
