export type Config = {
  routingBaseUrl: string;
  routingApiKey: string;
  claudeBin: string;
  workspaceRoot: string;
  sessionStorePath: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  maxTurns: number | null;
  streamIntermediate: boolean;
  // 24h-window outbound buffer (see docs/prd/24h-window-and-buffering.md).
  waBufferDir: string;
  waBufferTtlHours: number;
  waBufferMaxPerPhone: number;
  waBufferSweepIntervalMin: number;
  // Phone numbers (WhatsApp msisdn, no "+") allowed to drive self-service
  // re-auth over chat when the Claude token expires. Empty = feature off.
  adminPhones: string[];
};

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required env var: ${name}`);
  return v.trim();
}

function getIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): Config {
  const maxTurnsRaw = process.env.CLAUDE_MAX_TURNS;
  const maxTurns = maxTurnsRaw ? Number.parseInt(maxTurnsRaw, 10) : null;
  const workspaceRoot = process.env.CLAUDE_WORKSPACE_ROOT ?? "./workspaces";
  return {
    routingBaseUrl: required("ROUTING_BASE_URL"),
    routingApiKey: required("ROUTING_API_KEY"),
    claudeBin: process.env.CLAUDE_BIN?.trim() || "claude",
    workspaceRoot,
    sessionStorePath: process.env.SESSION_STORE_PATH ?? "./data/sessions.json",
    permissionMode: (process.env.CLAUDE_PERMISSION_MODE ?? "default") as Config["permissionMode"],
    maxTurns: maxTurns && Number.isFinite(maxTurns) ? maxTurns : null,
    streamIntermediate: /^(1|true|yes)$/i.test(process.env.CLAUDE_STREAM_INTERMEDIATE ?? ""),
    waBufferDir: process.env.WA_BUFFER_DIR ?? `${workspaceRoot}/wa-buffer`,
    waBufferTtlHours: getIntEnv("WA_BUFFER_TTL_HOURS", 72),
    waBufferMaxPerPhone: getIntEnv("WA_BUFFER_MAX_PER_PHONE", 50),
    waBufferSweepIntervalMin: getIntEnv("WA_BUFFER_SWEEP_INTERVAL_MIN", 15),
    adminPhones: (process.env.ADMIN_PHONE ?? "")
      .split(",")
      .map((s) => s.replace(/[^0-9]/g, ""))
      .filter((s) => s.length > 0),
  };
}

export function wsUrlFromHttpBase(base: string): string {
  if (base.startsWith("https://")) return `${base.replace("https://", "wss://")}/ws`;
  return `${base.replace("http://", "ws://")}/ws`;
}
