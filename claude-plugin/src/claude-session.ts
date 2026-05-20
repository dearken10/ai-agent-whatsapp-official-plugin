import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { SessionStore } from "./session-store.ts";

export type ClaudeReply = {
  text: string;
  sessionId: string;
};

type ClaudeResult = {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
};

function workspaceFor(cfg: Config, phone: string): string {
  // Phone numbers are stable identifiers; sanitize to a filesystem-safe dirname.
  const safe = phone.replace(/[^a-zA-Z0-9]/g, "_");
  return join(cfg.workspaceRoot, safe);
}

export function workspaceForPhone(cfg: Config, phone: string): string {
  return workspaceFor(cfg, phone);
}

export async function dispatchToClaude(
  cfg: Config,
  store: SessionStore,
  phone: string,
  prompt: string,
): Promise<ClaudeReply> {
  const cwd = workspaceFor(cfg, phone);
  await mkdir(cwd, { recursive: true });

  const resume = store.get(phone);
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    cfg.permissionMode,
  ];
  if (resume) args.push("--resume", resume);
  if (cfg.maxTurns) args.push("--max-turns", String(cfg.maxTurns));

  const stdout = await runClaude(cfg.claudeBin, cwd, args);
  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(stdout) as ClaudeResult;
  } catch {
    throw new Error(`claude returned non-JSON output: ${stdout.slice(0, 500)}`);
  }

  if (parsed.is_error) {
    throw new Error(`claude error (${parsed.subtype ?? "unknown"}): ${parsed.result ?? ""}`);
  }

  const text = (parsed.result ?? "").trim();
  const sessionId = parsed.session_id ?? resume ?? "";
  if (sessionId && sessionId !== resume) await store.set(phone, sessionId);

  return { text, sessionId };
}

function runClaude(bin: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      reject(new Error(`claude spawn failed (bin=${bin}): ${err.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}
