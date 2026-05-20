import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { loadConfig, wsUrlFromHttpBase, type Config } from "./config.ts";
import { fetchMedia, sendOutboundText, sendTypingIndicator, startTypingHeartbeat } from "./transport.ts";
import { SessionStore } from "./session-store.ts";
import { dispatchToClaude, dispatchToClaudeStream, workspaceForPhone } from "./claude-session.ts";

type WsEnvelope = {
  type: "INBOUND_MESSAGE" | "PAIRING_COMPLETE" | "HEARTBEAT" | "ERROR";
  payload: Record<string, unknown>;
  timestamp: string;
  message_id: string;
};

function nextBackoffMs(attempt: number): number {
  return Math.min(60_000, Math.pow(2, attempt) * 1_000) + Math.floor(Math.random() * 500);
}

function guessExt(mime: string, fileName: string): string {
  if (fileName && extname(fileName)) return extname(fileName);
  if (mime.startsWith("image/jpeg")) return ".jpg";
  if (mime.startsWith("image/png")) return ".png";
  if (mime.startsWith("image/webp")) return ".webp";
  if (mime.startsWith("image/gif")) return ".gif";
  if (mime.startsWith("video/mp4")) return ".mp4";
  if (mime.startsWith("audio/ogg")) return ".ogg";
  if (mime.startsWith("audio/mp4") || mime.startsWith("audio/mpeg")) return ".m4a";
  if (mime.startsWith("application/pdf")) return ".pdf";
  return ".bin";
}

// Media goes through Claude as a file on disk: we save it under the user's
// workspace and reference it by relative path. Claude reads it with its
// built-in Read tool — works for images, PDFs, text attachments.
async function buildPrompt(
  cfg: Config,
  phone: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const text = String(payload.text ?? "");
  const mediaId = String(payload.mediaId ?? "");
  if (!mediaId) return text;

  const mediaType = String(payload.mediaType ?? "file");
  const caption = String(payload.caption ?? "");
  const fileName = String(payload.fileName ?? "");
  const mediaUrl = String(payload.mediaUrl ?? "");

  try {
    const { data, mimeType } = await fetchMedia(cfg, mediaId, mediaUrl);
    const ext = guessExt(mimeType || "", fileName);
    const dir = join(workspaceForPhone(cfg, phone), "inbox");
    await mkdir(dir, { recursive: true });
    const fname = `${Date.now()}${ext}`;
    await writeFile(join(dir, fname), data);
    const rel = `./inbox/${fname}`;

    const lines: string[] = [];
    if (caption) lines.push(caption);
    if (text) lines.push(text);
    lines.push(`(User attached a ${mediaType}: ${rel})`);
    return lines.join("\n");
  } catch (err) {
    console.error(`media handling failed: ${String(err)}`);
    return text || `[${mediaType} received]`;
  }
}

// WhatsApp Cloud API caps text messages at 4096 chars. Chunk on newline
// boundaries where possible so we don't split mid-sentence.
function chunkText(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + max);
    let split = end;
    if (end < text.length) {
      const lastNl = text.lastIndexOf("\n", end);
      if (lastNl > start + max / 2) split = lastNl + 1;
    }
    chunks.push(text.slice(start, split).trim());
    start = split;
  }
  return chunks.filter((c) => c.length > 0);
}

async function handleInbound(
  cfg: Config,
  store: SessionStore,
  envelope: WsEnvelope,
): Promise<void> {
  const from = String(envelope.payload.from ?? "");
  if (!from) return;

  const prompt = await buildPrompt(cfg, from, envelope.payload);
  if (!prompt) return;

  console.log(`inbound from=${from} promptLen=${prompt.length}`);

  if (cfg.streamIntermediate) {
    // Streaming mode: each outbound message naturally dismisses typing at
    // Meta. We re-prime typing ~200 ms after every intermediate send so the
    // indicator reappears between messages. The schedule is cancellable —
    // when Claude emits the `result` event ("done" in our callback), we
    // clear any pending schedule before it fires. That way the FINAL reply
    // doesn't leave "typing…" stuck on for 25 s after Claude has exited.
    const messageId = envelope.message_id;
    let typingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTyping: Promise<unknown> = Promise.resolve();
    const scheduleTyping = (): void => {
      if (!messageId) return;
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typingTimer = null;
        pendingTyping = sendTypingIndicator(cfg, messageId).catch(() => undefined);
      }, 200);
    };
    const stopTyping = async (): Promise<void> => {
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = null;
      await pendingTyping;
    };

    if (messageId) {
      sendTypingIndicator(cfg, messageId).catch(() => undefined);
    }

    try {
      const { sessionId } = await dispatchToClaudeStream(cfg, store, from, prompt, async (event) => {
        if (event.kind === "text") {
          for (const chunk of chunkText(event.text)) {
            await sendOutboundText(cfg, from, chunk);
          }
          scheduleTyping();
        } else if (event.kind === "tool") {
          await sendOutboundText(cfg, from, `… ${event.summary}`);
          scheduleTyping();
        } else if (event.kind === "done") {
          await stopTyping();
        }
      });
      await stopTyping();
      console.log(`claude reply session=${sessionId} (streamed)`);
    } catch (err) {
      await stopTyping();
      throw err;
    }
    return;
  }

  // Non-streaming mode: keep the typing indicator alive on a timer while
  // Claude is working, then STOP the heartbeat (and await any in-flight ping)
  // BEFORE sending the final reply. Stopping first guarantees Meta sees
  // /typing settle before /send arrives, so no post-message typing.
  const heartbeat = envelope.message_id
    ? startTypingHeartbeat(cfg, envelope.message_id)
    : null;
  try {
    const reply = await dispatchToClaude(cfg, store, from, prompt);
    console.log(`claude reply session=${reply.sessionId} len=${reply.text.length}`);
    if (heartbeat) await heartbeat.stop();
    if (!reply.text) return;
    for (const chunk of chunkText(reply.text)) {
      await sendOutboundText(cfg, from, chunk);
    }
  } catch (err) {
    if (heartbeat) await heartbeat.stop();
    throw err;
  }
}

async function runOnce(cfg: Config, store: SessionStore): Promise<void> {
  const url = wsUrlFromHttpBase(cfg.routingBaseUrl);
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${cfg.routingApiKey}` },
    });

    let pingTimer: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (pingTimer) clearInterval(pingTimer);
      ws.removeAllListeners();
      resolve();
    };

    ws.on("open", () => {
      console.log(`ws connected: ${url}`);
      pingTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, 30_000);
    });

    ws.on("message", async (raw) => {
      try {
        const envelope = JSON.parse(String(raw)) as WsEnvelope;
        if (envelope.type === "PAIRING_COMPLETE") {
          console.log("pairing complete");
          return;
        }
        if (envelope.type !== "INBOUND_MESSAGE") return;
        await handleInbound(cfg, store, envelope);
      } catch (err) {
        console.error(`inbound handling error: ${String(err)}`);
      }
    });

    ws.on("close", finish);
    ws.on("error", (err) => {
      console.warn(`ws error: ${String(err)}`);
      finish();
    });
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new SessionStore(cfg.sessionStorePath);
  await store.load();

  let attempt = 0;
  for (;;) {
    try {
      await runOnce(cfg, store);
    } catch (err) {
      console.error(`run failed: ${String(err)}`);
    }
    const waitMs = nextBackoffMs(++attempt);
    console.log(`reconnecting in ${waitMs}ms`);
    await delay(waitMs);
  }
}

main().catch((err) => {
  console.error(`fatal: ${String(err)}`);
  process.exit(1);
});
