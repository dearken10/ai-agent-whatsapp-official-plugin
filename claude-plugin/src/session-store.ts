import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type SessionMap = Record<string, { sessionId: string; updatedAt: string }>;

export class SessionStore {
  private map: SessionMap = {};
  private loaded = false;
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      this.map = JSON.parse(raw) as SessionMap;
    } catch {
      this.map = {};
    }
    this.loaded = true;
  }

  get(phone: string): string | null {
    return this.map[phone]?.sessionId ?? null;
  }

  async set(phone: string, sessionId: string): Promise<void> {
    this.map[phone] = { sessionId, updatedAt: new Date().toISOString() };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.map, null, 2));
  }
}
