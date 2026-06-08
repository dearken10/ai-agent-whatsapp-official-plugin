import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { CHANNEL_CONFIG_KEY, PLUGIN_ID } from "./constants.js";
import type { Buffer, BufferedMessage } from "./buffer.js";
import type { ResolvedWhatsappOfficialAccount } from "./types.js";

// Local sentinel wab — the plugin only ever talks to one WABA per account, so
// we don't need to track the real wab number client-side. The buffer dir uses
// this as the per-wab partition.
export const LOCAL_WAB = "_default";

// Module-scoped buffer singleton. The OpenClaw SDK's outbound adapter contract
// is fixed (`{ cfg, accountId, to, text }` → `{ messageId }`), so we can't
// thread a Buffer through every caller. The gateway sets this at startup and
// transport functions use it implicitly. If unset (legacy or stand-alone test),
// send is best-effort with no buffering — same behaviour as before this PRD.
let activeBuffer: Buffer | undefined;
export function setActiveBuffer(b: Buffer | undefined): void {
  activeBuffer = b;
}
export function getActiveBuffer(): Buffer | undefined {
  return activeBuffer;
}

export type SendOutboundResult = {
  status: "delivered" | "queued";
  messageId?: string;
  localId?: string;
  templateSent?: boolean;
  to: string;
};

type SendResponse =
  | { status: "accepted"; messageId: string }
  | { status: "window_closed"; templateSent?: boolean };

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
  buffer?: Buffer;
}): Promise<SendOutboundResult> {
  const account = resolveAccountFromCfg(params.cfg, params.accountId);
  if (!account.apiKey) {
    throw new Error(`${PLUGIN_ID} channel is not paired yet (missing apiKey in config)`);
  }
  const buffer = params.buffer ?? activeBuffer;
  const mediaType = (params.mediaType as BufferedMessage["mediaType"]) ?? "document";

  if (buffer && (await buffer.hasPending(LOCAL_WAB, params.to))) {
    const m = await buffer.enqueue({
      wab: LOCAL_WAB, phone: params.to, kind: "media",
      mediaUrl: params.mediaUrl, mediaType, caption: params.caption, fileName: params.fileName,
    });
    return { status: "queued", localId: m.id, templateSent: false, to: params.to };
  }
  const res = await postSend({
    baseUrl: account.routingBaseUrl,
    apiKey: account.apiKey,
    body: {
      toPhoneNumber: params.to,
      mediaUrl: params.mediaUrl,
      mediaType: params.mediaType,
      caption: params.caption ?? "",
      fileName: params.fileName ?? "",
    },
  });
  if (res.status === "accepted") {
    return { status: "delivered", messageId: res.messageId, to: params.to };
  }
  const templateSent = res.templateSent === true;
  if (buffer) {
    const m = await buffer.enqueue({
      wab: LOCAL_WAB, phone: params.to, kind: "media",
      mediaUrl: params.mediaUrl, mediaType, caption: params.caption, fileName: params.fileName,
    });
    return { status: "queued", localId: m.id, templateSent, to: params.to };
  }
  return { status: "queued", localId: "(no-buffer)", templateSent, to: params.to };
}

export async function sendOutboundText(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  buffer?: Buffer;
}): Promise<SendOutboundResult> {
  const account = resolveAccountFromCfg(params.cfg, params.accountId);
  if (!account.apiKey) {
    throw new Error(`${PLUGIN_ID} channel is not paired yet (missing apiKey in config)`);
  }
  const buffer = params.buffer ?? activeBuffer;

  // Efficiency throttle: while a backlog exists for this phone, skip the
  // round-trip and enqueue directly. The server-side template_throttle is
  // the authoritative cost guard; this just avoids known-bad calls.
  if (buffer && (await buffer.hasPending(LOCAL_WAB, params.to))) {
    const m = await buffer.enqueue({ wab: LOCAL_WAB, phone: params.to, kind: "text", text: params.text });
    return { status: "queued", localId: m.id, templateSent: false, to: params.to };
  }
  const res = await postSend({
    baseUrl: account.routingBaseUrl,
    apiKey: account.apiKey,
    body: { toPhoneNumber: params.to, text: params.text },
  });
  if (res.status === "accepted") {
    return { status: "delivered", messageId: res.messageId, to: params.to };
  }
  // window_closed: buffer locally if we have a buffer; otherwise the message
  // is lost (no buffer configured — same as pre-PRD behaviour).
  const templateSent = res.templateSent === true;
  if (buffer) {
    const m = await buffer.enqueue({ wab: LOCAL_WAB, phone: params.to, kind: "text", text: params.text });
    return { status: "queued", localId: m.id, templateSent, to: params.to };
  }
  return { status: "queued", localId: "(no-buffer)", templateSent, to: params.to };
}

async function postSend(args: {
  baseUrl: string;
  apiKey: string;
  body: { toPhoneNumber: string; text?: string; mediaUrl?: string; mediaType?: string; caption?: string; fileName?: string };
}): Promise<SendResponse> {
  const response = await fetch(`${args.baseUrl}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify(args.body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`send failed: ${response.status} ${raw}`);
  }
  try {
    return JSON.parse(raw) as SendResponse;
  } catch {
    throw new Error(`send returned non-JSON: ${raw}`);
  }
}

// flushPending drains buffered entries for (wab, phone) via /api/v1/send.
// Stops on the first window_closed or transient error; remaining entries
// stay on disk for the next inbound trigger.
export async function flushPending(args: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  buffer: Buffer;
  wab: string;
  phone: string;
}): Promise<{ delivered: number; remaining: number; stoppedReason?: string }> {
  const account = resolveAccountFromCfg(args.cfg, args.accountId);
  if (!account.apiKey) return { delivered: 0, remaining: 0, stoppedReason: "no_api_key" };
  const pending = await args.buffer.listPending(args.wab, args.phone);
  let delivered = 0;
  for (const m of pending) {
    try {
      const res = await postSend({
        baseUrl: account.routingBaseUrl,
        apiKey: account.apiKey,
        body: sendBodyFromBuffered(m),
      });
      if (res.status === "accepted") {
        await args.buffer.markDelivered(args.wab, args.phone, m.id);
        delivered += 1;
        continue;
      }
      // window_closed mid-flush — pause and try again on next inbound.
      return { delivered, remaining: pending.length - delivered, stoppedReason: "window_closed" };
    } catch (err) {
      await args.buffer.recordFailure(args.wab, args.phone, m.id, String(err));
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
