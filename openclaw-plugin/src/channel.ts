import {
  formatPairingApproveHint,
  type ChannelOutboundAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { CHANNEL_CONFIG_KEY } from "./constants.js";
import { startWhatsappOfficialGatewayAccount } from "./gateway.js";
import { whatsappOfficialOnboardingAdapter } from "./onboarding.js";
import { resolveAccountFromCfg, sendOutboundText } from "./transport.js";
import type { ResolvedWhatsappOfficialAccount } from "./types.js";

function readChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return (channels?.[CHANNEL_CONFIG_KEY] as Record<string, unknown> | undefined) ?? {};
}

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, accountId, to, text }) => {
    const result = await sendOutboundText({
      cfg: cfg as OpenClawConfig,
      accountId,
      to,
      text,
    });
    return { channel: CHANNEL_CONFIG_KEY, messageId: result.messageId };
  },
};

export const whatsappOfficialPlugin: ChannelPlugin<ResolvedWhatsappOfficialAccount> = {
  id: CHANNEL_CONFIG_KEY,
  meta: {
    id: CHANNEL_CONFIG_KEY,
    label: "Official WhatsApp API (imBee)",
    selectionLabel: "Official WhatsApp API (imBee)",
    docsPath: `/channels/${CHANNEL_CONFIG_KEY}`,
    docsLabel: CHANNEL_CONFIG_KEY,
    blurb: "Managed WhatsApp Cloud API channel via imBee routing (pairing + WebSocket inbound).",
    order: 130,
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  onboarding: whatsappOfficialOnboardingAdapter,
  reload: { configPrefixes: [`channels.${CHANNEL_CONFIG_KEY}`] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        routingBaseUrl: { type: "string", default: "http://localhost:28080" },
        instanceId: { type: "string" },
        apiKey: { type: "string" },
        allowFrom: { type: "array", items: { type: "string" } },
        defaultTo: { type: "string" },
        dmPolicy: {
          type: "string",
          enum: ["open", "pairing", "allowlist", "disabled"],
          default: "open",
        },
        groupPolicy: {
          type: "string",
          enum: ["open", "disabled", "allowlist"],
          default: "disabled",
        },
      },
      required: [],
    },
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (cfg, accountId) => resolveAccountFromCfg(cfg as OpenClawConfig, accountId),
    defaultAccountId: () => "default",
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg }) =>
      resolveAccountFromCfg(cfg as OpenClawConfig).allowFrom,
  },
  setup: {
    applyAccountConfig: ({ cfg, input }) => {
      const current = readChannelSection(cfg);
      return {
        ...(cfg as Record<string, unknown>),
        channels: {
          ...((cfg as { channels?: Record<string, unknown> }).channels ?? {}),
          [CHANNEL_CONFIG_KEY]: {
            ...current,
            ...(input as Record<string, unknown>),
          },
        },
      } as OpenClawConfig;
    },
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy,
      allowFrom: account.allowFrom,
      policyPath: `channels.${CHANNEL_CONFIG_KEY}.dmPolicy`,
      allowFromPath: `channels.${CHANNEL_CONFIG_KEY}.allowFrom`,
      approveHint: formatPairingApproveHint(CHANNEL_CONFIG_KEY),
      normalizeEntry: (raw) => raw.replace(/^whatsapp:/i, "").trim(),
    }),
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
  },
  outbound,
  gateway: {
    startAccount: (ctx) => startWhatsappOfficialGatewayAccount(ctx),
  },
};
