// Plugin-local buffer for outbound WhatsApp messages that the routing server
// rejected with `status: "window_closed"` (24-hour customer service window
// closed). Bodies live ONLY on this machine — the routing server never sees
// them again until flush. See docs/prd/24h-window-and-buffering.md.

import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type BufferedKind = "text" | "media";

export type BufferedMessage = {
  id: string;
  wab: string;
  phone: string;
  kind: BufferedKind;
  text?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "audio" | "document";
  caption?: string;
  fileName?: string;
  enqueuedAt: string; // ISO-8601
  attempts: number;
  lastError?: string;
};

export type BufferConfig = {
  dir: string; // root directory; per-phone files live at dir/<wab>/<phone>.jsonl
  maxPerPhone: number; // overflow drops the oldest pending
  ttlMs: number; // sweep removes entries older than this
};

// Serialise file IO per (wab, phone) so concurrent enqueue / flush / sweep
// calls never interleave. Each task chains onto the previous one's promise.
const queues = new Map<string, Promise<unknown>>();

function lockKey(wab: string, phone: string): string {
  return `${wab}|${phone}`;
}

function runSerial<T>(wab: string, phone: string, fn: () => Promise<T>): Promise<T> {
  const k = lockKey(wab, phone);
  const prev = queues.get(k) ?? Promise.resolve();
  // Run fn whether or not the previous task succeeded — failures must not
  // poison the queue for subsequent callers.
  const next = prev.then(fn, fn);
  queues.set(
    k,
    next.finally(() => {
      if (queues.get(k) === next) queues.delete(k);
    }),
  );
  return next as Promise<T>;
}

function fileFor(cfg: BufferConfig, wab: string, phone: string): string {
  // Phones and wab numbers contain `+`; that's fine in a filename. Avoid `/`.
  return join(cfg.dir, safeSegment(wab), `${safeSegment(phone)}.jsonl`);
}

function safeSegment(s: string): string {
  return s.replace(/[/\\]/g, "_");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // mkdir respects umask; force 0700 explicitly so umask 0022 doesn't widen us.
  await chmod(path, 0o700).catch(() => undefined);
}

async function readAll(file: string): Promise<BufferedMessage[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: BufferedMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as BufferedMessage);
    } catch {
      // Skip malformed lines; better than losing the rest of the file.
    }
  }
  return out;
}

async function writeAll(file: string, msgs: BufferedMessage[]): Promise<void> {
  await ensureDir(dirname(file));
  if (msgs.length === 0) {
    // No pending — remove the file so enumeratePending doesn't list it.
    await unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    return;
  }
  const body = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

async function appendOne(file: string, msg: BufferedMessage): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, JSON.stringify(msg) + "\n", { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

export class Buffer {
  private readonly cfg: BufferConfig;
  constructor(cfg: BufferConfig) {
    this.cfg = cfg;
  }

  async enqueue(msg: Omit<BufferedMessage, "id" | "enqueuedAt" | "attempts"> & Partial<Pick<BufferedMessage, "id" | "enqueuedAt" | "attempts">>): Promise<BufferedMessage> {
    const full: BufferedMessage = {
      id: msg.id ?? randomUUID(),
      enqueuedAt: msg.enqueuedAt ?? new Date().toISOString(),
      attempts: msg.attempts ?? 0,
      ...msg,
    } as BufferedMessage;
    return runSerial(full.wab, full.phone, async () => {
      const file = fileFor(this.cfg, full.wab, full.phone);
      const existing = await readAll(file);
      existing.push(full);
      // Enforce cap: drop oldest while above limit.
      while (existing.length > this.cfg.maxPerPhone) {
        existing.shift();
      }
      await writeAll(file, existing);
      return full;
    });
  }

  async hasPending(wab: string, phone: string): Promise<boolean> {
    return runSerial(wab, phone, async () => {
      const msgs = await readAll(fileFor(this.cfg, wab, phone));
      return msgs.length > 0;
    });
  }

  async listPending(wab: string, phone: string): Promise<BufferedMessage[]> {
    return runSerial(wab, phone, async () => {
      const msgs = await readAll(fileFor(this.cfg, wab, phone));
      // Oldest first.
      msgs.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
      return msgs;
    });
  }

  // enumeratePending walks the buffer dir for every (wab, phone) that has
  // at least one entry. Used by startup-flush.
  async enumeratePending(): Promise<{ wab: string; phone: string }[]> {
    const out: { wab: string; phone: string }[] = [];
    let wabDirs: string[];
    try {
      wabDirs = await readdir(this.cfg.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    for (const wab of wabDirs) {
      let phones: string[];
      try {
        phones = await readdir(join(this.cfg.dir, wab));
      } catch {
        continue;
      }
      for (const p of phones) {
        if (!p.endsWith(".jsonl")) continue;
        const phone = p.slice(0, -".jsonl".length);
        out.push({ wab, phone });
      }
    }
    return out;
  }

  async markDelivered(wab: string, phone: string, id: string): Promise<void> {
    return runSerial(wab, phone, async () => {
      const file = fileFor(this.cfg, wab, phone);
      const msgs = await readAll(file);
      const remaining = msgs.filter((m) => m.id !== id);
      await writeAll(file, remaining);
    });
  }

  async recordFailure(wab: string, phone: string, id: string, err: string): Promise<void> {
    return runSerial(wab, phone, async () => {
      const file = fileFor(this.cfg, wab, phone);
      const msgs = await readAll(file);
      for (const m of msgs) {
        if (m.id === id) {
          m.attempts += 1;
          m.lastError = err;
        }
      }
      await writeAll(file, msgs);
    });
  }

  // sweepExpired removes entries older than cfg.ttlMs across all phones.
  // Returns the number removed. Best-effort; partial failures are logged.
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const cutoff = now.getTime() - this.cfg.ttlMs;
    let removed = 0;
    for (const { wab, phone } of await this.enumeratePending()) {
      await runSerial(wab, phone, async () => {
        const file = fileFor(this.cfg, wab, phone);
        const msgs = await readAll(file);
        const keep = msgs.filter((m) => {
          const t = Date.parse(m.enqueuedAt);
          if (Number.isNaN(t)) return true; // be conservative
          if (t < cutoff) {
            removed += 1;
            return false;
          }
          return true;
        });
        if (keep.length !== msgs.length) {
          await writeAll(file, keep);
        }
      });
    }
    return removed;
  }

  // clear is a convenience for tests / unpair cleanup.
  async clear(wab: string, phone: string): Promise<void> {
    return runSerial(wab, phone, async () => {
      const file = fileFor(this.cfg, wab, phone);
      await unlink(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    });
  }

  // Used only by tests.
  async _exists(wab: string, phone: string): Promise<boolean> {
    try {
      await stat(fileFor(this.cfg, wab, phone));
      return true;
    } catch {
      return false;
    }
  }
}
