import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { CHANNEL_CONFIG_KEY, PLUGIN_ID } from "./constants.js";
import type { ResolvedWhatsappOfficialAccount } from "./types.js";

function readSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return (channels?.[CHANNEL_CONFIG_KEY] as Record<string, unknown> | undefined) ?? {};
}

export function resolveAccountFromCfg(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedWhatsappOfficialAccount {
  const section = readSection(cfg);
  const routingBaseUrl = String(section.routingBaseUrl ?? "https://openclaw-plugin.dev.ent.imbee.io");
  const instanceId = typeof section.instanceId === "string" ? section.instanceId : "";
  const apiKeyRaw = section.apiKey;
  const apiKey = typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0 ? apiKeyRaw : null;
  const allowFrom = Array.isArray(section.allowFrom)
    ? section.allowFrom.filter((item): item is string => typeof item === "string")
    : [];
  const defaultTo = typeof section.defaultTo === "string" ? section.defaultTo : undefined;
  const dmPolicy = typeof section.dmPolicy === "string" ? section.dmPolicy : "open";
  const groupPolicy =
    section.groupPolicy === "open" || section.groupPolicy === "disabled" || section.groupPolicy === "allowlist"
      ? section.groupPolicy
      : "disabled";
  return {
    accountId: accountId ?? "default",
    configured: Boolean(routingBaseUrl && instanceId && apiKey),
    routingBaseUrl,
    instanceId,
    apiKey,
    allowFrom,
    defaultTo,
    dmPolicy,
    groupPolicy,
  };
}

export async function requestPairingCode(
  baseUrl: string,
): Promise<{ instanceId: string; pairingCode: string; expiresAt: string; waMeUrl: string; apiKey: string }> {
  const response = await fetch(`${baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`pair request failed: ${response.status}`);
  }
  return response.json() as Promise<{
    instanceId: string;
    pairingCode: string;
    expiresAt: string;
    waMeUrl: string;
    apiKey: string;
  }>;
}

export async function sendTypingIndicator(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  messageId: string;
}): Promise<void> {
  const account = resolveAccountFromCfg(params.cfg, params.accountId);
  if (!account.apiKey) return;
  await fetch(`${account.routingBaseUrl}/api/v1/typing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.apiKey}`,
    },
    body: JSON.stringify({ messageId: params.messageId }),
  }).catch(() => {/* best-effort */});
}

export async function fetchMediaContent(
  account: ResolvedWhatsappOfficialAccount,
  mediaId: string,
  directUrl?: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (!account.apiKey) throw new Error(`${PLUGIN_ID}: missing apiKey`);
  const path = `${account.routingBaseUrl}/api/v1/media/${encodeURIComponent(mediaId)}`;
  const url = directUrl ? `${path}?url=${encodeURIComponent(directUrl)}` : path;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${account.apiKey}` } });
  if (!response.ok) throw new Error(`media fetch failed: ${response.status}`);
  const mimeType = response.headers.get("Content-Type") ?? "application/octet-stream";
  const buffer = await response.arrayBuffer();
  return { data: new Uint8Array(buffer), mimeType };
}

export async function sendOutboundMedia(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  mediaUrl: string;
  mediaType: string;
  caption?: string;
  fileName?: string;
}): Promise<{ messageId: string; to: string }> {
  const account = resolveAccountFromCfg(params.cfg, params.accountId);
  if (!account.apiKey) {
    throw new Error(`${PLUGIN_ID} channel is not paired yet (missing apiKey in config)`);
  }
  const response = await fetch(`${account.routingBaseUrl}/api/v1/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.apiKey}`,
    },
    body: JSON.stringify({
      toPhoneNumber: params.to,
      mediaUrl: params.mediaUrl,
      mediaType: params.mediaType,
      caption: params.caption ?? "",
      fileName: params.fileName ?? "",
    }),
  });
  if (!response.ok) {
    throw new Error(`send media failed: ${response.status}`);
  }
  const data = (await response.json()) as { messageId?: string };
  return {
    messageId: data.messageId ?? `wamid.local-${Date.now()}`,
    to: params.to,
  };
}

export async function sendOutboundText(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
}): Promise<{ messageId: string; to: string }> {
  const account = resolveAccountFromCfg(params.cfg, params.accountId);
  if (!account.apiKey) {
    throw new Error(`${PLUGIN_ID} channel is not paired yet (missing apiKey in config)`);
  }
  const response = await fetch(`${account.routingBaseUrl}/api/v1/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.apiKey}`,
    },
    body: JSON.stringify({
      toPhoneNumber: params.to,
      text: params.text,
    }),
  });
  if (!response.ok) {
    throw new Error(`send failed: ${response.status}`);
  }
  const data = (await response.json()) as { messageId?: string };
  return {
    messageId: data.messageId ?? `wamid.local-${Date.now()}`,
    to: params.to,
  };
}
