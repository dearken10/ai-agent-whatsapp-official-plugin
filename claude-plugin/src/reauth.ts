import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Config } from "./config.ts";

// Self-service re-auth over chat. When Claude Code's OAuth token expires, an
// admin (allowlisted via ADMIN_PHONE) can restore it without SSH:
//   1. plugin catches the AuthError, runs `claude auth login`, captures the
//      one-time URL and DMs it to the admin (login process kept alive),
//   2. admin approves in a browser and replies with the code (looks like
//      "aaa#bbb") in chat,
//   3. plugin feeds the code to the waiting login process over stdin; on
//      success the credentials file is rewritten and the next turn works.
//
// The URL is PKCE-bound to the live login process, so the SAME process that
// printed it must receive the code — hence the module-level singleton below.

type Pending = {
  child: ChildProcessWithoutNullStreams;
  phone: string;
  url: string;
  timer: NodeJS.Timeout;
};

let pending: Pending | null = null;

// Auth codes are "<base64url>#<base64url>" (the state suffix). Be lenient on
// lengths but require the '#' join so ordinary chat text never matches.
const AUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{16,}#[A-Za-z0-9_-]{8,}$/;

const URL_CAPTURE_TIMEOUT_MS = 15_000;
const CODE_EXCHANGE_TIMEOUT_MS = 30_000;
const PENDING_TTL_MS = 5 * 60_000;

export function isAdmin(cfg: Config, phone: string): boolean {
  const norm = phone.replace(/[^0-9]/g, "");
  return cfg.adminPhones.includes(norm);
}

export function looksLikeAuthCode(text: string): boolean {
  return AUTH_CODE_PATTERN.test(text.trim());
}

export function hasPendingReauth(phone: string): boolean {
  return pending !== null && pending.phone === phone;
}

function clearPending(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
  pending = null;
}

// Start `claude auth login`, capture the login URL, and keep the process alive
// waiting for the code. Any prior pending login is discarded first.
export async function startReauth(
  cfg: Config,
  phone: string,
): Promise<{ url: string } | { error: string }> {
  clearPending();

  const child = spawn(cfg.claudeBin, ["auth", "login", "--claudeai"], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  return await new Promise((resolve) => {
    let out = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ error: "timed out waiting for login URL" });
    }, URL_CAPTURE_TIMEOUT_MS);

    const onData = (d: Buffer): void => {
      out += String(d);
      const m = out.match(/https:\/\/\S+/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timeout);
        const url = m[0];
        // Hand the live process to the module singleton; a TTL timer kills it
        // if the admin never replies with a code.
        const ttl = setTimeout(() => clearPending(), PENDING_TTL_MS);
        pending = { child, phone, url, timer: ttl };
        resolve({ url });
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ error: `failed to start login: ${err.message}` });
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ error: `login exited early (code ${code})` });
    });
  });
}

// Feed the code to the waiting login process. Resolves once it exits: code 0
// means the credentials file was rewritten and the token is live again.
export async function submitReauthCode(code: string): Promise<{ ok: boolean; message: string }> {
  const p = pending;
  if (!p) return { ok: false, message: "no login in progress" };

  return await new Promise((resolve) => {
    let out = "";
    let settled = false;

    const done = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearPending();
      resolve({ ok, message });
    };

    const timeout = setTimeout(() => {
      done(false, "timed out completing login");
    }, CODE_EXCHANGE_TIMEOUT_MS);

    p.child.stdout.on("data", (d) => {
      out += String(d);
    });
    p.child.stderr.on("data", (d) => {
      out += String(d);
    });
    p.child.once("exit", (exitCode) => {
      if (exitCode === 0) done(true, "ok");
      else done(false, out.trim().split("\n").slice(-3).join(" ").slice(0, 200) || `exit ${exitCode}`);
    });
    p.child.once("error", (err) => done(false, err.message));

    p.child.stdin.write(code.trim() + "\n");
  });
}
