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
  const dmDenyMessage =
    typeof section.dmDenyMessage === "string" && section.dmDenyMessage.trim().length > 0
      ? section.dmDenyMessage.trim()
      : "You are not authorised to use this service. Please contact the service owner for access.";
  const defaultTo = typeof section.defaultTo === "string" ? section.defaultTo : undefined;
  const dmPolicy = typeof section.dmPolicy === "string" ? section.dmPolicy : "open";
  const groupPolicy =
    section.groupPolicy === "open" || section.groupPolicy === "disabled" || section.groupPolicy === "allowlist"
      ? section.groupPolicy
      : "disabled";
  const inviteId = typeof section.inviteId === "string" && section.inviteId.trim().length > 0
    ? section.inviteId.trim()
    : undefined;
  return {
    accountId: accountId ?? "default",
    configured: Boolean(routingBaseUrl && instanceId && apiKey),
    routingBaseUrl,
    instanceId,
    apiKey,
    inviteId,
    allowFrom,
    dmDenyMessage,
    defaultTo,
    dmPolicy,
    groupPolicy,
  };
}

export async function requestPairingCode(
  baseUrl: string,
  mode: "single_use" | "persistent" = "single_use",
): Promise<{
  mode: string;
  instanceId: string;
  pairingCode: string;
  waMeUrl: string;
  apiKey: string;
  /** Defined only for single_use mode */
  expiresAt?: string;
  /** Defined only for persistent mode */
  inviteId?: string;
}> {
  const response = await fetch(`${baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(`pair request failed: ${response.status}`);
  }
  return response.json() as Promise<{
    mode: string;
    instanceId: string;
    pairingCode: string;
    waMeUrl: string;
    apiKey: string;
    expiresAt?: string;
    inviteId?: string;
  }>;
}

export async function revokePersistentInvite(
  baseUrl: string,
  apiKey: string,
  inviteId: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/pair/invite/${encodeURIComponent(inviteId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`revoke invite failed: ${response.status}`);
  }
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
