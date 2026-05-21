import type { ChannelSetupAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { CHANNEL_CONFIG_KEY } from "./constants.js";

function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, channelKey, patch } = params;
  const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
  const existing = (channels[channelKey] as Record<string, unknown> | undefined) ?? {};
  return {
    ...(cfg as Record<string, unknown>),
    channels: {
      ...channels,
      [channelKey]: { ...existing, ...patch },
    },
  } as OpenClawConfig;
}

/**
 * Setup adapter that writes instanceId + apiKey returned from the pairing
 * request into the config. Interactive wizard flows (prompter) live in the
 * onboarding adapter; this adapter is for headless / CLI config apply.
 */
export const whatsappOfficialSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, input }) => {
    const patch: Record<string, unknown> = {};
    if (typeof (input as { instanceId?: string }).instanceId === "string") {
      patch.instanceId = (input as { instanceId?: string }).instanceId;
    }
    if (typeof (input as { apiKey?: string }).apiKey === "string") {
      patch.apiKey = (input as { apiKey?: string }).apiKey;
    }
    if (typeof (input as { routingBaseUrl?: string }).routingBaseUrl === "string") {
      patch.routingBaseUrl = (input as { routingBaseUrl?: string }).routingBaseUrl;
    }
    return patchScopedAccountConfig({ cfg, channelKey: CHANNEL_CONFIG_KEY, patch });
  },
};
