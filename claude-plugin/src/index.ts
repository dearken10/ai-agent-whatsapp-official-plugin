import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { loadConfig, wsUrlFromHttpBase, type Config } from "./config.ts";
import { fetchMedia, flushPending, LOCAL_WAB, sendOutboundText, startTypingHeartbeat } from "./transport.ts";
import { Buffer } from "./buffer.ts";
import { SessionStore } from "./session-store.ts";
import { dispatchToClaude, dispatchToClaudeStream, workspaceForPhone } from "./claude-session.ts";

type WsEnvelope = {
  type: "INBOUND_MESSAGE" | "PAIRING_COMPLETE" | "WINDOW_OPENED" | "HEARTBEAT" | "ERROR";
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
  buffer: Buffer,
  envelope: WsEnvelope,
): Promise<void> {
  const from = String(envelope.payload.from ?? "");
  if (!from) return;

  const prompt = await buildPrompt(cfg, from, envelope.payload);
  if (!prompt) return;

  console.log(`inbound from=${from} promptLen=${prompt.length}`);

  if (cfg.streamIntermediate) {
    // Streaming mode flow:
    //   1. inbound message    → start typing heartbeat (recurring refresh)
    //   2. each intermediate  → send message, then one-shot typing ping
    //   3. repeat (2) until claude emits `done`
    //   4. stop typing heartbeat (awaits all in-flight pings)
    //   5. send final result
    //
    // The "final result" is the LAST assistant text in the stream. We buffer
    // it: each text event flushes any previously-buffered text as an
    // intermediate; the buffer's contents at `done` time become the final.
    // Sending the final AFTER the heartbeat stops means no typing ping can
    // race the final outbound message at Meta — no lingering post-reply
    // "typing…" indicator.
    const messageId = envelope.message_id;
    const heartbeat = messageId ? startTypingHeartbeat(cfg, messageId) : null;

    let bufferedFinalText: string | null = null;
    const flushBuffered = async (asFinal: boolean): Promise<void> => {
      if (!bufferedFinalText) return;
      const text = bufferedFinalText;
      bufferedFinalText = null;
      for (const chunk of chunkText(text)) {
        await sendOutboundText(cfg, from, chunk, buffer);
      }
      // Intermediates get a follow-up typing ping; the final does NOT —
      // its purpose is to terminate the turn.
      if (!asFinal) heartbeat?.ping();
    };

    try {
      const { sessionId } = await dispatchToClaudeStream(cfg, store, from, prompt, async (event) => {
        if (event.kind === "text") {
          const isFirstText = bufferedFinalText === null;
          console.log(`stream event=text len=${event.text.length} bufferedBefore=${isFirstText ? "(none)" : "yes"}`);
          await flushBuffered(false);
          bufferedFinalText = event.text;
        } else if (event.kind === "tool") {
          console.log(`stream event=tool name=${event.name}`);
          await flushBuffered(false);
          await sendOutboundText(cfg, from, `… ${event.summary}`);
          heartbeat?.ping();
        } else if (event.kind === "done") {
          console.log(`stream event=done bufferedFinal=${bufferedFinalText ? bufferedFinalText.length + " chars" : "(empty)"}`);
          // Stop the schedule FIRST so no further typing pings can be
          // initiated, then await all pending pings, THEN send final.
          if (heartbeat) await heartbeat.stop();
          await flushBuffered(true);
        }
      });
      // Belt-and-suspenders for the rare case `done` didn't fire
      // (e.g. claude exited without a result event).
      if (heartbeat) await heartbeat.stop();
      await flushBuffered(true);
      console.log(`claude reply session=${sessionId} (streamed)`);
    } catch (err) {
      if (heartbeat) await heartbeat.stop();
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

async function runOnce(cfg: Config, store: SessionStore, buffer: Buffer): Promise<void> {
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
      // Flush any buffer that survived a previous session. The server's
      // template_throttle prevents duplicate billable template sends, so
      // calling flush on a still-closed window is safe.
      void flushAll(cfg, buffer).catch((err) => {
        console.warn(`startup flush error: ${String(err)}`);
      });
    });

    ws.on("message", async (raw) => {
      try {
        const envelope = JSON.parse(String(raw)) as WsEnvelope;
        if (envelope.type === "PAIRING_COMPLETE") {
          console.log("pairing complete");
          return;
        }
        if (envelope.type === "WINDOW_OPENED") {
          const phone = String(envelope.payload.phone ?? "");
          if (!phone) return;
          console.log(`window opened for ${phone}; flushing buffer`);
          const r = await flushPending(cfg, buffer, LOCAL_WAB, phone);
          console.log(`flush delivered=${r.delivered} remaining=${r.remaining} stopped=${r.stoppedReason ?? "ok"}`);
          // Buffer was empty — give the user feedback so their tap isn't silently swallowed.
          if (r.delivered === 0 && r.remaining === 0) {
            try {
              await sendOutboundText(cfg, phone, "There is no unread messages.");
            } catch (err) {
              console.warn(`window_opened fallback send failed phone=${phone} err=${String(err)}`);
            }
          }
          return;
        }
        if (envelope.type !== "INBOUND_MESSAGE") return;
        // Flush before agent dispatch so the user sees prior buffered context
        // first; the agent then reacts to the inbound with that context already
        // in the user's view.
        const from = String(envelope.payload.from ?? "");
        if (from) {
          const r = await flushPending(cfg, buffer, LOCAL_WAB, from);
          if (r.delivered > 0) {
            console.log(`pre-dispatch flush delivered=${r.delivered} remaining=${r.remaining}`);
          }
        }
        await handleInbound(cfg, store, buffer, envelope);
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

// flushAll runs flushPending for every (wab, phone) with pending entries on
// disk. Called once per WS connect so that buffered messages from a prior
// session attempt delivery as soon as we're back online.
async function flushAll(cfg: Config, buffer: Buffer): Promise<void> {
  const pairs = await buffer.enumeratePending();
  if (pairs.length === 0) return;
  console.log(`startup flush: ${pairs.length} (wab, phone) pair(s) with pending entries`);
  for (const { wab, phone } of pairs) {
    try {
      const r = await flushPending(cfg, buffer, wab, phone);
      console.log(`startup flush phone=${phone} delivered=${r.delivered} remaining=${r.remaining} stopped=${r.stoppedReason ?? "ok"}`);
    } catch (err) {
      console.warn(`startup flush failed phone=${phone} err=${String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new SessionStore(cfg.sessionStorePath);
  await store.load();

  const buffer = new Buffer({
    dir: cfg.waBufferDir,
    maxPerPhone: cfg.waBufferMaxPerPhone,
    ttlMs: cfg.waBufferTtlHours * 3600_000,
  });

  // Sweep expired entries periodically. Best-effort; the sweep is idempotent
  // so a missed tick is harmless.
  const sweeperMs = cfg.waBufferSweepIntervalMin * 60_000;
  setInterval(() => {
    void buffer.sweepExpired().then((n) => {
      if (n > 0) console.log(`buffer.expired removed=${n}`);
    }).catch((err) => {
      console.warn(`buffer sweep failed: ${String(err)}`);
    });
  }, sweeperMs).unref();

  let attempt = 0;
  for (;;) {
    try {
      await runOnce(cfg, store, buffer);
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
