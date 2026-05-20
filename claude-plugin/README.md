# Claude Code WhatsApp Bridge

Forwards inbound WhatsApp messages — already authenticated and routed by the imBee backend in this repo — into a local **Claude Code CLI** session. One paired WhatsApp user = one persistent Claude Code session (continuity preserved via `claude --resume <session-id>` per turn).

## How it relates to the rest of the repo

```
WhatsApp ─► Meta/360dialog webhook
         ─► backend/ (Go)            ── shared, agent-agnostic
            ├── verifies pairing
            ├── routes inbound by phone → instance
            └── opens a per-instance WebSocket
                    │
                    │  WsEnvelope { type, payload, timestamp, message_id }
                    ▼
            ┌───────┴───────┐
            │               │
   openclaw-plugin/    claude-plugin/   ← this folder
   (in-process)        (spawns `claude` CLI per turn)
```

The backend doesn't know which plugin is on the other end. The contract is:

- **Inbound:** WS pushes `INBOUND_MESSAGE` with `{ from, text? | mediaId?, mediaUrl?, mediaType?, mimeType?, caption?, fileName? }`.
- **Outbound:** `POST /api/v1/send` with `Bearer <apiKey>` and `{ toPhoneNumber, text }`.

## How a turn works

```
WhatsApp message arrives
  ↓ backend WS → claude-plugin
  ↓ download any media into ./workspaces/<phone>/inbox/
  ↓ build prompt string (caption + any "(User attached: ./inbox/foo.jpg)" hint)
  ↓ spawn:  claude -p "<prompt>"
                    --output-format json
                    --permission-mode <mode>
                    [--resume <session-id>]   ← preserves history
                    [--max-turns N]
            (cwd = ./workspaces/<phone>)
  ↓ parse stdout {result, session_id}
  ↓ persist session_id under that phone
  ↓ chunk result to ≤3500 chars, POST /api/v1/send per chunk
```

Each turn is a fresh `claude` process — but Claude Code treats them as a single ongoing session because we pass `--resume`. The user gets continuity; the bridge gets a clean per-turn exit code.

## Prerequisites

1. **Claude Code CLI installed and authenticated** on this machine. Run `claude` once interactively to log in. The bridge inherits the same auth.
2. **`ROUTING_API_KEY`** from pairing — see `npm run pair`.

## Quick start

```bash
cd claude-plugin
npm install
cp .env.example .env

# Pair: prints a CLAW-XXXX code + wa.me link, prints apiKey on success
npm run pair

# Put the apiKey into .env as ROUTING_API_KEY, then start the bridge
npm start
```

Send a WhatsApp message to the shared imBee number — the local `claude` CLI handles it and the reply goes back over WhatsApp.

## Files

| File | Purpose |
|:---|:---|
| `src/index.ts` | Long-lived WS loop, media handling, chunking. Mirrors `openclaw-plugin/src/gateway.ts`. |
| `src/claude-session.ts` | Spawns `claude -p --resume <sid> --output-format json` per turn. Parses the result. |
| `src/session-store.ts` | Persists `phone → claude session_id` to a JSON file on disk. |
| `src/transport.ts` | HTTP calls into the backend (send, typing, media fetch). |
| `src/pair.ts` | Headless pairing helper. |

## Configuration

| Env var | Default | Purpose |
|:---|:---|:---|
| `ROUTING_BASE_URL` | — | Backend base URL |
| `ROUTING_API_KEY` | — | Bearer token from pairing |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_WORKSPACE_ROOT` | `./workspaces` | Per-sender working dir parent |
| `SESSION_STORE_PATH` | `./data/sessions.json` | Phone → session id persistence |
| `CLAUDE_PERMISSION_MODE` | `default` | `default` / `acceptEdits` / `bypassPermissions` / `plan` |
| `CLAUDE_MAX_TURNS` | (unset) | Optional cap on agent turns per inbound message |

## Permission mode warning

WhatsApp is unattended. If `claude` needs permission to run a tool and nobody is at the terminal to approve, the turn hangs until `--max-turns` cuts it off. Trade-offs:

- `default` — safest, but tool-heavy requests will stall.
- `acceptEdits` — auto-approves file edits inside cwd. Reasonable default for a sandboxed per-user workspace.
- `bypassPermissions` — auto-approves everything. Only use if `CLAUDE_WORKSPACE_ROOT` is fully sandboxed (separate user, container, or VM) — Claude can run any shell command at this level.
