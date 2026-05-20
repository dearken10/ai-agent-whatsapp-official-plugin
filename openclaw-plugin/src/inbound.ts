import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { CHANNEL_CONFIG_KEY, PLUGIN_ID } from "./constants.js";
import { getWhatsappOfficialRuntime } from "./runtime.js";
import { fetchMediaContent, sendOutboundText, sendTypingIndicator } from "./transport.js";
import type { ResolvedWhatsappOfficialAccount } from "./types.js";

/**
 * Downloads media from the routing server and returns a body string for the agent.
 * Images are embedded as base64 data URIs so vision-capable models can read them.
 * All other types are represented as a human-readable description.
 */
async function buildMediaBody(
  account: ResolvedWhatsappOfficialAccount,
  mediaId: string,
  directUrl: string,
  mediaType: string,
  mimeType: string,
  caption: string,
  fileName: string,
): Promise<string> {
  const typeLabel = mediaType || "file";
  const label = fileName || caption || "";

  try {
    const { data, mimeType: resolvedMime } = await fetchMediaContent(account, mediaId, directUrl);
    const mime = resolvedMime || mimeType;

    if (mime.startsWith("image/")) {
      const b64 = Buffer.from(data).toString("base64");
      const dataUri = `data:${mime};base64,${b64}`;
      return caption ? `${caption}\n${dataUri}` : dataUri;
    }

    // For non-image types, describe the file so the agent is aware of it.
    const sizeKb = Math.round(data.byteLength / 1024);
    const parts = [`[${typeLabel}]`];
    if (label) parts.push(label);
    if (mime) parts.push(mime);
    parts.push(`${sizeKb} KB`);
    return parts.join(" · ");
  } catch (err) {
    console.error(`${PLUGIN_ID}: media download failed: ${String(err)}`);
    // Still notify the agent that a media message arrived even if download failed.
    const parts = [`[${typeLabel} received`];
    if (label) parts.push(`: ${label}`);
    parts.push("]");
    return parts.join("");
  }
}

export async function handleWhatsappOfficialInbound(params: {
  channelLabel: string;
  account: ResolvedWhatsappOfficialAccount;
  cfg: OpenClawConfig;
  from: string;
  text: string;
  messageId: string;
  mediaId?: string;
  mediaUrl?: string;
  mediaType?: string;
  mimeType?: string;
  caption?: string;
  fileName?: string;
}): Promise<void> {
  const { account, cfg, from, messageId, channelLabel } = params;
  const { mediaId, mediaUrl, mediaType, mimeType, caption, fileName } = params;

  // Build the message body seen by the agent.
  let text: string;
  if (params.text) {
    text = params.text;
  } else if (mediaId) {
    text = await buildMediaBody(account, mediaId, mediaUrl ?? "", mediaType ?? "", mimeType ?? "", caption ?? "", fileName ?? "");
    if (!text) return;
  } else {
    return;
  }

  // Fire-and-forget: mark message as read and show typing indicator
  sendTypingIndicator({ cfg, accountId: account.accountId, messageId }).catch(() => {/* best-effort */});

  const runtime = getWhatsappOfficialRuntime();
  const target = from.trim();

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_CONFIG_KEY,
    accountId: account.accountId,
    peer: { kind: "direct", id: target },
  });

  const storePath = runtime.channel.session.resolveStorePath(
    (cfg as { session?: { store?: unknown } }).session?.store,
    { agentId: route.agentId },
  );

  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: channelLabel,
    from,
    timestamp: new Date().toISOString(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: from,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? account.accountId,
    ChatType: "direct",
    ConversationLabel: from,
    Provider: CHANNEL_CONFIG_KEY,
    Surface: CHANNEL_CONFIG_KEY,
    MessageSid: messageId,
    MessageSidFull: messageId,
    Timestamp: new Date().toISOString(),
    OriginatingChannel: CHANNEL_CONFIG_KEY,
    OriginatingTo: target,
    CommandAuthorized: true,
    CommandSource: "text",
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: CHANNEL_CONFIG_KEY,
      to: target,
      accountId: route.accountId,
    },
    onRecordError: (err: unknown) => {
      console.error(`${PLUGIN_ID}: session record failed: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_CONFIG_KEY,
    accountId: route.accountId,
  });

  const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay,
      deliver: async (payload) => {
        const replyText =
          payload && typeof payload === "object" && "text" in payload
            ? String((payload as { text?: string }).text ?? "")
            : "";
        console.log(`${PLUGIN_ID}: deliver called to=${target} textLen=${replyText.length} empty=${!replyText.trim()}`);
        if (!replyText.trim()) return;
        try {
          await sendOutboundText({
            cfg,
            accountId: account.accountId,
            to: target,
            text: replyText,
          });
          console.log(`${PLUGIN_ID}: deliver sent to=${target}`);
        } catch (err) {
          console.error(`${PLUGIN_ID}: deliver sendOutboundText failed to=${target}: ${String(err)}`);
          throw err;
        }
      },
      onError: (err: unknown) => {
        console.error(`${PLUGIN_ID}: reply dispatcher error: ${String(err)}`);
      },
    });

  console.log(`${PLUGIN_ID}: dispatchReplyFromConfig start from=${from}`);
  await runtime.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: { ...replyOptions, onModelSelected },
  });
  console.log(`${PLUGIN_ID}: dispatchReplyFromConfig done from=${from}`);
  markDispatchIdle();
}
