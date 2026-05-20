import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";
import type { Config } from "./config.ts";
import type { SessionStore } from "./session-store.ts";

export type ClaudeReply = {
  text: string;
  sessionId: string;
};

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "done" };

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

// Streaming variant: spawn `claude --output-format stream-json --verbose` and
// invoke onEvent() for each assistant text block and tool_use as they arrive.
// Returns the final session id. Throws on non-zero exit or `is_error`.
export async function dispatchToClaudeStream(
  cfg: Config,
  store: SessionStore,
  phone: string,
  prompt: string,
  onEvent: (event: StreamEvent) => Promise<void>,
): Promise<{ sessionId: string }> {
  const cwd = workspaceFor(cfg, phone);
  await mkdir(cwd, { recursive: true });

  const resume = store.get(phone);
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    cfg.permissionMode,
  ];
  if (resume) args.push("--resume", resume);
  if (cfg.maxTurns) args.push("--max-turns", String(cfg.maxTurns));

  const child = spawn(cfg.claudeBin, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });

  let sessionId = resume ?? "";
  let resultError: string | null = null;
  const rl = readline.createInterface({ input: child.stdout });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") sessionId = event.session_id;
      continue;
    }

    if (event.type === "assistant") {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          await onEvent({ kind: "text", text: block.text.trim() });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "Tool");
          const summary = summarizeTool(name, block.input);
          await onEvent({ kind: "tool", name, summary });
        }
      }
      continue;
    }

    if (event.type === "result") {
      if (typeof event.session_id === "string") sessionId = event.session_id;
      if (event.is_error) {
        resultError = `claude error (${event.subtype ?? "unknown"}): ${event.result ?? ""}`;
      }
      // Signal end-of-turn while the stream is still being read, so the
      // caller can cancel any pending post-message typing schedule before
      // it fires and leaves typing visible 25 s after the final reply.
      await onEvent({ kind: "done" });
    }
  }

  await new Promise<void>((res, rej) => {
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`claude exited ${code}: ${stderr.trim()}`));
    });
    child.on("error", rej);
  });

  if (resultError) throw new Error(resultError);
  if (sessionId && sessionId !== resume) await store.set(phone, sessionId);
  return { sessionId };
}

function summarizeTool(name: string, rawInput: unknown): string {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const s = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
  const truncate = (text: string, max = 140): string =>
    text.length > max ? text.slice(0, max - 1) + "…" : text;
  switch (name) {
    case "Bash":
      return `Bash: ${truncate(s("command"))}`;
    case "Read":
      return `Read: ${s("file_path")}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `${name}: ${s("file_path")}`;
    case "Glob":
    case "Grep": {
      const pattern = s("pattern");
      const path = s("path");
      return `${name}: ${pattern}${path ? ` in ${path}` : ""}`;
    }
    case "WebFetch":
      return `WebFetch: ${truncate(s("url"))}`;
    case "WebSearch":
      return `WebSearch: ${truncate(s("query"))}`;
    case "Task":
      return `Task: ${truncate(s("description") || s("subagent_type") || "subagent")}`;
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos.length : 0;
      return `TodoWrite: ${todos} item${todos === 1 ? "" : "s"}`;
    }
    default: {
      const firstString = Object.values(input).find((v) => typeof v === "string") as
        | string
        | undefined;
      return firstString ? `${name}: ${truncate(firstString)}` : name;
    }
  }
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
