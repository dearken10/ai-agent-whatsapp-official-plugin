// Plugin-local buffer for outbound WhatsApp messages that the routing server
// rejected with `status: "window_closed"` (24-hour customer service window
// closed). Bodies live ONLY on this machine — the routing server never sees
// them again until flush. See docs/prd/24h-window-and-buffering.md.

import {
  appendFile,
  chmod,
  mkdir,
  open,
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

// Cross-process lock for the per-(wab, phone) jsonl. runSerial above serialises
// in-process callers; this lock keeps a second Node process (e.g. the send-wa
// CLI invoked from a Claude skill) from racing the main plugin's flush.
// Implementation: O_EXCL create of a sidecar `.lock` file is atomic on POSIX.
// Stale locks (process crashed mid-operation) are reclaimed after LOCK_STALE_MS.
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 5_000;

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  await ensureDir(dirname(lockPath));
  const start = Date.now();
  let backoff = 25;
  for (;;) {
    let fh;
    try {
      fh = await open(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtime.getTime() > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry immediately.
        continue;
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(`buffer lock timeout: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 250);
      continue;
    }
    try {
      return await fn();
    } finally {
      await fh.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
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
    const file = fileFor(this.cfg, full.wab, full.phone);
    return runSerial(full.wab, full.phone, () => withFileLock(file, async () => {
      const existing = await readAll(file);
      existing.push(full);
      // Enforce cap: drop oldest while above limit.
      while (existing.length > this.cfg.maxPerPhone) {
        existing.shift();
      }
      await writeAll(file, existing);
      return full;
    }));
  }

  async hasPending(wab: string, phone: string): Promise<boolean> {
    const file = fileFor(this.cfg, wab, phone);
    return runSerial(wab, phone, () => withFileLock(file, async () => {
      const msgs = await readAll(file);
      return msgs.length > 0;
    }));
  }

  async listPending(wab: string, phone: string): Promise<BufferedMessage[]> {
    const file = fileFor(this.cfg, wab, phone);
    return runSerial(wab, phone, () => withFileLock(file, async () => {
      const msgs = await readAll(file);
      // Oldest first.
      msgs.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
      return msgs;
    }));
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
    const file = fileFor(this.cfg, wab, phone);
    return runSerial(wab, phone, () => withFileLock(file, async () => {
      const msgs = await readAll(file);
      const remaining = msgs.filter((m) => m.id !== id);
      await writeAll(file, remaining);
    }));
  }

  async recordFailure(wab: string, phone: string, id: string, err: string): Promise<void> {
    const file = fileFor(this.cfg, wab, phone);
    return runSerial(wab, phone, () => withFileLock(file, async () => {
      const msgs = await readAll(file);
      for (const m of msgs) {
        if (m.id === id) {
          m.attempts += 1;
          m.lastError = err;
        }
      }
      await writeAll(file, msgs);
    }));
  }

  // sanitizeOversized rewrites any text entry whose body exceeds `maxTextChars`
  // as N smaller entries produced by `chunker`, preserving order. Runs at
  // startup so buffers persisted by older plugin versions (which allowed
  // oversized bodies to accumulate — see docs/prd/24h-window-and-buffering.md)
  // self-heal on the next boot instead of poisoning every subsequent flush.
  // Returns { splitEntries, newEntries } for observability. Best-effort per
  // (wab, phone); a failure on one file does not abort the sweep.
  async sanitizeOversized(
    maxTextChars: number,
    chunker: (text: string, max: number) => string[],
  ): Promise<{ splitEntries: number; newEntries: number }> {
    let splitEntries = 0;
    let newEntries = 0;
    for (const { wab, phone } of await this.enumeratePending()) {
      const file = fileFor(this.cfg, wab, phone);
      await runSerial(wab, phone, () => withFileLock(file, async () => {
        const msgs = await readAll(file);
        const rewritten: BufferedMessage[] = [];
        let changed = false;
        for (const m of msgs) {
          if (m.kind !== "text" || !m.text || m.text.length <= maxTextChars) {
            rewritten.push(m);
            continue;
          }
          const parts = chunker(m.text, maxTextChars);
          if (parts.length <= 1) {
            rewritten.push(m);
            continue;
          }
          // Preserve the original enqueuedAt so ordering vs surrounding
          // entries is stable. Mint fresh ids so the split chunks can be
          // individually delivered / failed / dropped.
          for (const p of parts) {
            rewritten.push({
              ...m,
              id: randomUUID(),
              text: p,
              attempts: 0,
              lastError: undefined,
            });
          }
          splitEntries += 1;
          newEntries += parts.length;
          changed = true;
        }
        if (changed) {
          await writeAll(file, rewritten);
        }
      }));
    }
    return { splitEntries, newEntries };
  }

  // sweepExpired removes entries older than cfg.ttlMs across all phones.
  // Returns the number removed. Best-effort; partial failures are logged.
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const cutoff = now.getTime() - this.cfg.ttlMs;
    let removed = 0;
    for (const { wab, phone } of await this.enumeratePending()) {
      const file = fileFor(this.cfg, wab, phone);
      await runSerial(wab, phone, () => withFileLock(file, async () => {
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
      }));
    }
    return removed;
  }

  // clear is a convenience for tests / unpair cleanup.
  async clear(wab: string, phone: string): Promise<void> {
    const file = fileFor(this.cfg, wab, phone);
    return runSerial(wab, phone, () => withFileLock(file, async () => {
      await unlink(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }));
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
