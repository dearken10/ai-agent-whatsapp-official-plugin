/** Must match `openclaw.plugin.json` id and any `defineChannelPluginEntry({ id })` call. */
export const PLUGIN_ID = "whatsapp-official" as const;

/** Channel id used for routing, sessions, and config key under `channels.<key>`. */
export const CHANNEL_CONFIG_KEY = "whatsapp-official" as const;
