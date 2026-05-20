export type Config = {
  routingBaseUrl: string;
  routingApiKey: string;
  claudeBin: string;
  workspaceRoot: string;
  sessionStorePath: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  maxTurns: number | null;
  streamIntermediate: boolean;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required env var: ${name}`);
  return v.trim();
}

export function loadConfig(): Config {
  const maxTurnsRaw = process.env.CLAUDE_MAX_TURNS;
  const maxTurns = maxTurnsRaw ? Number.parseInt(maxTurnsRaw, 10) : null;
  return {
    routingBaseUrl: required("ROUTING_BASE_URL"),
    routingApiKey: required("ROUTING_API_KEY"),
    claudeBin: process.env.CLAUDE_BIN?.trim() || "claude",
    workspaceRoot: process.env.CLAUDE_WORKSPACE_ROOT ?? "./workspaces",
    sessionStorePath: process.env.SESSION_STORE_PATH ?? "./data/sessions.json",
    permissionMode: (process.env.CLAUDE_PERMISSION_MODE ?? "default") as Config["permissionMode"],
    maxTurns: maxTurns && Number.isFinite(maxTurns) ? maxTurns : null,
    streamIntermediate: /^(1|true|yes)$/i.test(process.env.CLAUDE_STREAM_INTERMEDIATE ?? ""),
  };
}

export function wsUrlFromHttpBase(base: string): string {
  if (base.startsWith("https://")) return `${base.replace("https://", "wss://")}/ws`;
  return `${base.replace("http://", "ws://")}/ws`;
}
