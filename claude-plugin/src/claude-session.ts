import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import type { SessionStore } from "./session-store.ts";

// Template files copied into each new per-user workspace. Lives next to
// src/ in the package layout (see claude-plugin/workspace-template/).
const TEMPLATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "workspace-template",
);

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Seed the workspace from workspace-template/. Substitutes {{USER_PHONE}}
// in file contents. Idempotent: existing destination files are left alone
// so the user (or Claude) can edit them between turns without being
// overwritten.
async function seedWorkspace(cwd: string, phone: string): Promise<void> {
  if (!(await pathExists(TEMPLATE_DIR))) return;
  await copyTemplate(TEMPLATE_DIR, cwd, { USER_PHONE: phone });
}

async function copyTemplate(
  src: string,
  dst: string,
  vars: Record<string, string>,
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dstPath, { recursive: true });
      await copyTemplate(srcPath, dstPath, vars);
    } else {
      if (await pathExists(dstPath)) continue;
      const raw = await readFile(srcPath, "utf8");
      const rendered = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
      await writeFile(dstPath, rendered);
    }
  }
}

function claudeEnv(phone: string): NodeJS.ProcessEnv {
  // USER_PHONE is what the workspace's CLAUDE.md / notify-user skill expect.
  // ROUTING_BASE_URL and ROUTING_API_KEY are already in process.env from .env.
  return { ...process.env, USER_PHONE: phone };
}

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

// Claude Code writes synthetic "API Error: …" assistant messages into the
// session transcript when the upstream API refuses (usage policy, 4xx). Those
// synthetic messages carry a UUID id, not the required `msg_…` id, so the
// next `--resume` 400s with "previous_message_id must start with msg_" — the
// session is permanently poisoned. Detect the marker in streamed text so we
// can clear the session id and start fresh on the next turn.
const API_ERROR_TEXT_PATTERN = /^API Error:/;

export class SessionResetError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`session reset: ${reason}`);
    this.name = "SessionResetError";
    this.reason = reason;
  }
}

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
  await seedWorkspace(cwd, phone);

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

  console.log(`claude turn phone=${phone} cwd=${cwd} resume=${resume ?? "(none)"}`);
  const stdout = await runClaude(cfg.claudeBin, cwd, args, claudeEnv(phone));
  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(stdout) as ClaudeResult;
  } catch {
    throw new Error(`claude returned non-JSON output: ${stdout.slice(0, 500)}`);
  }

  const resultText = (parsed.result ?? "").trim();
  if (API_ERROR_TEXT_PATTERN.test(resultText)) {
    await store.clear(phone);
    throw new SessionResetError(resultText.split("\n")[0].slice(0, 200));
  }
  if (parsed.is_error) {
    throw new Error(`claude error (${parsed.subtype ?? "unknown"}): ${resultText}`);
  }

  const sessionId = parsed.session_id ?? resume ?? "";
  if (sessionId && sessionId !== resume) await store.set(phone, sessionId);
  console.log(`claude turn done phone=${phone} sessionId=${sessionId || "(none)"}`);

  return { text: resultText, sessionId };
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
  await seedWorkspace(cwd, phone);

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
    env: claudeEnv(phone),
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });

  // Attach exit/error listeners synchronously, BEFORE the for-await loop on
  // stdout. If we attached them after the loop, claude could exit fast enough
  // that the `exit` event fires before we subscribe — listener never called,
  // the awaited promise hangs forever, and the turn silently never completes.
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });

  console.log(`claude turn phone=${phone} cwd=${cwd} resume=${resume ?? "(none)"} (streaming)`);

  // Persist session id eagerly. If a downstream send/typing call throws inside
  // the onEvent callback, the for-await loop unwinds and the final store.set
  // never runs — that would silently drop the new session id and the NEXT
  // turn would spawn without --resume, starting from a blank history.
  //
  // The flip side: if the CLI/API itself errors (usage-policy refusal,
  // non-zero exit), the forked session id is poisoned — its transcript may
  // have a user turn with no valid msg_… assistant reply, and the NEXT
  // --resume will 400 with "previous_message_id must start with msg_". So
  // track whether we persisted, and roll back to the prior session id on
  // terminal errors below.
  let persistedNewSession = false;
  const persistIfNew = async (id: string): Promise<void> => {
    if (!id || id === resume) return;
    await store.set(phone, id);
    persistedNewSession = true;
  };
  const rollbackSession = async (): Promise<void> => {
    if (!persistedNewSession) return;
    if (resume) await store.set(phone, resume);
    else await store.clear(phone);
    persistedNewSession = false;
  };

  let sessionId = resume ?? "";
  let resultError: string | null = null;
  let sessionPoisoned = false;
  let poisonReason = "";
  const markPoisoned = (text: string): void => {
    if (sessionPoisoned) return;
    sessionPoisoned = true;
    poisonReason = text.split("\n")[0].slice(0, 200);
    console.log(`stream API error suppressed (session will reset): ${poisonReason}`);
  };
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
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
        await persistIfNew(sessionId);
      }
      continue;
    }

    if (event.type === "assistant") {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      const blockTypes = (message?.content ?? []).map((b) => String(b.type));
      console.log(`stream assistant blocks=[${blockTypes.join(",")}]`);
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          const text = block.text.trim();
          if (API_ERROR_TEXT_PATTERN.test(text)) {
            markPoisoned(text);
            continue;
          }
          await onEvent({ kind: "text", text });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "Tool");
          const summary = summarizeTool(name, block.input);
          await onEvent({ kind: "tool", name, summary });
        }
      }
      continue;
    }

    if (event.type === "result") {
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
        await persistIfNew(sessionId);
      }
      const resultText = typeof event.result === "string" ? event.result : "";
      if (event.is_error) {
        resultError = `claude error (${event.subtype ?? "unknown"}): ${resultText}`;
      }
      if (API_ERROR_TEXT_PATTERN.test(resultText)) {
        markPoisoned(resultText);
      }
      // Signal end-of-turn while the stream is still being read, so the
      // caller can cancel any pending post-message typing schedule before
      // it fires and leaves typing visible 25 s after the final reply.
      await onEvent({ kind: "done" });
    }
  }

  const code = await exitPromise;
  if (sessionPoisoned) {
    await store.clear(phone);
    persistedNewSession = false;
    throw new SessionResetError(poisonReason);
  }
  if (code !== 0) {
    await rollbackSession();
    throw new Error(`claude exited ${code}: ${stderr.trim()}`);
  }

  if (resultError) {
    await rollbackSession();
    throw new Error(resultError);
  }
  // Belt-and-suspenders: most session ids are persisted eagerly above; this
  // catches the rare case where session_id only showed up after init/result.
  await persistIfNew(sessionId);
  console.log(`claude turn done phone=${phone} sessionId=${sessionId || "(none)"} (streaming)`);
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

function runClaude(
  bin: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
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
