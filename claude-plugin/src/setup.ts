// Guided setup — mirrors openclaw-plugin/src/onboarding.ts:
//   1. verify the Claude Code CLI is installed and runnable
//   2. confirm the routing backend is reachable
//   3. request a pairing code, render QR + wa.me link + code
//   4. wait for PAIRING_COMPLETE over the WS (no manual confirm needed)
//   5. ask for permission mode + workspace root
//   6. write merged values into ./.env
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import QRCode from "qrcode";
import WebSocket from "ws";
import { wsUrlFromHttpBase } from "./config.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = "https://openclaw-plugin.dev.ent.imbee.io";
const ENV_PATH = resolve(process.cwd(), ".env");
const PAIRING_WAIT_MS = 10 * 60 * 1000;

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

type PairResult = {
  instanceId: string;
  pairingCode: string;
  apiKey: string;
  waMeUrl: string;
  expiresAt: string;
};

function bail(message: string): never {
  cancel(message);
  process.exit(1);
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) bail("Cancelled.");
  return value as T;
}

async function renderQr(url: string): Promise<string> {
  const qr = await QRCode.toString(url, { type: "utf8", small: true, margin: 2 });
  const lines = qr.split("\n");
  const maxLen = Math.max(...lines.map((l) => l.length));
  // Paint white background so the QR's quiet zone shows up on dark terminals
  // (same trick the openclaw plugin uses in onboarding.ts).
  const bg = lines
    .map((l) => `\x1b[47m\x1b[30m${l.padEnd(maxLen)}\x1b[0m`)
    .join("\n");
  const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
  return `${bg}\n${link}`;
}

async function checkClaudeCli(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function requestPairing(baseUrl: string): Promise<PairResult> {
  const res = await fetch(`${baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`pair request failed: ${res.status}`);
  return (await res.json()) as PairResult;
}

async function waitForPairingComplete(baseUrl: string, apiKey: string): Promise<void> {
  const url = wsUrlFromHttpBase(baseUrl);
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const timer = setTimeout(() => {
      ws.close();
      rej(new Error("timed out — please run setup again"));
    }, PAIRING_WAIT_MS);
    ws.on("message", (raw) => {
      try {
        const env = JSON.parse(String(raw)) as { type?: string };
        if (env.type === "PAIRING_COMPLETE") {
          clearTimeout(timer);
          ws.close();
          res();
        }
      } catch {
        // ignore parse errors
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });
  });
}

async function writeEnvFile(updates: Record<string, string>): Promise<void> {
  const existing: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    const raw = await readFile(ENV_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) existing[m[1]] = m[2];
    }
  }
  const merged = { ...existing, ...updates };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await mkdir(dirname(ENV_PATH), { recursive: true });
  await writeFile(ENV_PATH, body + "\n");
}

async function main(): Promise<void> {
  intro("Claude Code WhatsApp Bridge — Setup");

  note(
    [
      "This connects one WhatsApp number to a local Claude Code session.",
      "",
      "You'll need:",
      "  • The Claude Code CLI installed and logged in",
      "  • A WhatsApp account on the device that will pair",
    ].join("\n"),
    "What this does",
  );

  const claudeBin = unwrap(
    await text({
      message: "Path to the Claude Code CLI",
      initialValue: process.env.CLAUDE_BIN ?? "claude",
      validate: (v) => (v.trim() ? undefined : "Required"),
    }),
  ).trim();

  const verSpinner = spinner();
  verSpinner.start(`Checking ${claudeBin}…`);
  const version = await checkClaudeCli(claudeBin);
  if (!version) {
    verSpinner.stop(`Could not run ${claudeBin}`);
    bail(
      `Install Claude Code and run \`${claudeBin}\` once interactively to log in, then re-run this setup.`,
    );
  }
  verSpinner.stop(`Claude Code OK — ${version}`);

  const routingBaseUrl = unwrap(
    await text({
      message: "Backend routing server base URL",
      initialValue: process.env.ROUTING_BASE_URL ?? DEFAULT_BASE_URL,
      validate: (v) => (v.trim() ? undefined : "Required"),
    }),
  ).trim();

  const healthSpinner = spinner();
  healthSpinner.start("Pinging backend…");
  try {
    const res = await fetch(`${routingBaseUrl}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`/healthz returned ${res.status}`);
    healthSpinner.stop("Backend reachable");
  } catch (err) {
    healthSpinner.stop("Backend not reachable");
    bail(`Could not reach ${routingBaseUrl}: ${String(err)}`);
  }

  const pairSpinner = spinner();
  pairSpinner.start("Requesting pairing code…");
  let pair: PairResult;
  try {
    pair = await requestPairing(routingBaseUrl);
    pairSpinner.stop("Pairing code issued");
  } catch (err) {
    pairSpinner.stop("Failed to request pairing code");
    bail(String(err));
  }

  // QR has to bypass clack's note() — note() word-wraps whitespace and breaks
  // the QR module spacing (same caveat documented in openclaw onboarding.ts).
  const qr = await renderQr(pair.waMeUrl).catch(() => "");
  if (qr) process.stdout.write(`\n${qr}\n`);
  note(
    `Scan the QR above or open this link:\n${pair.waMeUrl}\n\nThen send this code to the imBee number when WhatsApp prompts:\n\n  ${pair.pairingCode}`,
    "Pair on WhatsApp",
  );

  const waitSpinner = spinner();
  waitSpinner.start("Waiting for WhatsApp to deliver the pairing code…");
  try {
    await waitForPairingComplete(routingBaseUrl, pair.apiKey);
    waitSpinner.stop("Paired successfully");
  } catch (err) {
    waitSpinner.stop("Pairing not completed");
    bail(String(err));
  }

  const permissionMode = unwrap(
    await select<PermissionMode>({
      message: "Claude permission mode (WhatsApp is unattended — pick carefully)",
      initialValue: (process.env.CLAUDE_PERMISSION_MODE as PermissionMode) ?? "acceptEdits",
      options: [
        { value: "default", label: "default — ask before any tool use (will stall: nobody's at the terminal)" },
        { value: "acceptEdits", label: "acceptEdits — auto-approve edits in workspace (recommended)" },
        { value: "bypassPermissions", label: "bypassPermissions — auto-approve everything (sandbox only!)" },
        { value: "plan", label: "plan — Claude proposes, never executes" },
      ],
    }),
  );

  const workspaceRoot = unwrap(
    await text({
      message: "Per-user workspace root (each phone gets a subdirectory here)",
      initialValue: process.env.CLAUDE_WORKSPACE_ROOT ?? "./workspaces",
    }),
  ).trim();

  const streamIntermediate = unwrap(
    await confirm({
      message:
        "Stream Claude's intermediate text and tool calls to WhatsApp? (more visibility, more messages)",
      initialValue: /^(1|true|yes)$/i.test(process.env.CLAUDE_STREAM_INTERMEDIATE ?? ""),
    }),
  );

  if (existsSync(ENV_PATH)) {
    const ok = unwrap(
      await confirm({
        message: `${ENV_PATH} exists — merge new values in?`,
        initialValue: true,
      }),
    );
    if (!ok) bail("Aborted. .env unchanged.");
  }

  await writeEnvFile({
    ROUTING_BASE_URL: routingBaseUrl,
    ROUTING_API_KEY: pair.apiKey,
    CLAUDE_BIN: claudeBin,
    CLAUDE_WORKSPACE_ROOT: workspaceRoot,
    CLAUDE_PERMISSION_MODE: permissionMode,
    CLAUDE_STREAM_INTERMEDIATE: String(streamIntermediate),
  });

  outro(
    [
      `Saved ${ENV_PATH}`,
      "",
      `Starting the bridge now — message the imBee shared number from your paired phone and \`${claudeBin}\` will reply.`,
      "",
      "(Stop with Ctrl-C. Restart later with `npm start`.)",
    ].join("\n"),
  );
}

main().catch((err) => {
  cancel(String(err));
  process.exit(1);
});
