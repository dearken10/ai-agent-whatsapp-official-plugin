# WhatsApp → AI Agent Bridge

> **Which agent are you connecting?**
> - **OpenClaw** — see [`openclaw-plugin/README.md`](./openclaw-plugin/README.md)
> - **Claude Code** — see [`claude-plugin/README.md`](./claude-plugin/README.md)

This repo bridges WhatsApp (via 360dialog or Meta Cloud API) to a locally-running AI agent. The backend is **agent-agnostic** — it speaks a small WebSocket + HTTP contract that any plugin can consume — and today ships with two first-class plugins:

- **`openclaw-plugin/`** — an OpenClaw channel plugin that runs inside the OpenClaw gateway.
- **`claude-plugin/`** — a standalone bridge that forwards each paired WhatsApp user into their own persistent Claude Code CLI session (one WhatsApp user ⇄ one `claude --resume <sid>` session).

Both plugins connect to the same backend and share the same pairing/webhook/window infrastructure, so you can pick per WhatsApp number — or run them side-by-side against different pairings.

**Repo layout:**

| Path | Description |
|:---|:---|
| `backend/` | Go routing server — pairing, webhook verification, WebSocket hub, media proxy, 24h-window enforcement, re-engagement templates (agent-agnostic) |
| `openclaw-plugin/` | OpenClaw channel plugin — runs inside the OpenClaw gateway |
| `claude-plugin/` | Claude Code bridge — forwards each paired WhatsApp user to their own Claude Code session, with a local buffer for messages sent outside the 24h window |
| `docs/` | PRD and technical design |
| `scripts/` | Dev, ngrok, deploy, and publish helpers |

---

## Quick start (local dev)

### Prerequisites

- Docker + Docker Compose
- Go ≥ 1.21 (for the dev CLI and building)
- An ngrok account (free tier is fine) for a public HTTPS URL
- A 360dialog or Meta WhatsApp Cloud API key

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env — set WA_PROVIDER, D360_API_KEY (or WABA_TOKEN), SHARED_WA_NUMBER
```

### 2. Start the backend

```bash
make up
# Backend: http://localhost:28080
```

Uses `STORE_DRIVER=file` by default (data saved to `./data/store.json`). No Postgres needed for local dev.

### 3. Expose to the internet (required for Meta webhooks)

```bash
make ngrok
# Prints a public HTTPS URL and registers it as the 360dialog webhook
# Copy the URL into .env as ROUTING_BASE_URL, then: make up
```

### 4. Pair your WhatsApp number

```bash
make pair
# Prints a pairing code e.g. CLAW-A3F9-Z7KL and a wa.me link
# Send the code from your WhatsApp to the shared number
```

Watch for the pairing confirmation:

```bash
make ws API_KEY=imbee_xxx
# Prints PAIRING_COMPLETE once you send the code
```

### 5. Wire up an agent

Pick one — both use the API key from step 4:

**Option A — OpenClaw**

```bash
openclaw plugins install -l ./openclaw-plugin    # dev link (no copy)
openclaw gateway restart
```

Add channel config to your OpenClaw config file:

```json5
{
  channels: {
    "whatsapp-official": {
      routingBaseUrl: "https://<your-ngrok-url>",
      instanceId: "your-openclaw-instance-id",
      apiKey: "imbee_…from_pair_response…",
      dmPolicy: "open"
    }
  }
}
```

**Option B — Claude Code**

```bash
cd claude-plugin
npm run setup    # walks you through pairing + writes .env + starts the bridge
```

(Or start from scratch with `npx claude-whatsapp-official-plugin setup` — it runs the same wizard without cloning this repo.)

### 6. Test

Send a WhatsApp message to the shared number — your agent (OpenClaw or Claude Code) should reply.

Simulate an inbound webhook locally:

```bash
TEXT="hello from test user" ./scripts/replay-webhook.sh
```

### 7. Stop

```bash
make down
```

---

## Cloud deployment (AWS)

Deploys the backend to a single EC2 t4g.nano (~$4/month). No database needed — uses the file store driver.

### Prerequisites

- AWS CLI installed (`brew install awscli`)
- AWS SSO access to your AWS organisation (set `AWS_PROD_PROFILE`, `AWS_DEV_PROFILE`, `AWS_SSO_START_URL`, `AWS_SSO_REGION` in `.env` — see `.env.example`)
- A domain name with DNS you can edit (required for HTTPS / Meta webhooks)

### 1. Authenticate with AWS SSO

```bash
eval "$(./scripts/aws-login.sh)"          # uses $AWS_PROD_PROFILE
eval "$(./scripts/aws-login.sh --dev)"    # uses $AWS_DEV_PROFILE
```

Or pass `PROFILE=` directly to deploy commands (no `eval` needed — see step 2).

### 2. Deploy

```bash
make deploy DOMAIN=api.example.com PROFILE=<account-id>_AdministratorAccess
```

This will:
- Cross-compile the Go binary for linux/arm64
- Create a key pair (default name `openclaw-wa`, saved as `~/.ssh/openclaw-wa.pem`), security group, and t4g.nano instance if they don't exist
- Upload the binary and `.env`
- Install Caddy (auto-HTTPS via Let's Encrypt) and set up systemd services

### 3. Point DNS

After deploy, add an **A record** in your DNS:

```
api.example.com  →  <Public IP printed by deploy>
```

Once DNS propagates, Caddy obtains a TLS certificate automatically. Verify:

```bash
curl https://api.example.com/healthz
```

### 4. Register the webhook

In your 360dialog Hub (or Meta App Dashboard):

```
Webhook URL:   https://api.example.com/webhooks/whatsapp
Verify token:  (value of WEBHOOK_VERIFY_TOKEN in .env)
```

### 5. Update config and redeploy

```bash
# In .env, set:
# ROUTING_BASE_URL=https://api.example.com

make deploy-update DOMAIN=api.example.com PROFILE=<account-id>_AdministratorAccess
```

### Subsequent deploys

| Command | Effect |
|:---|:---|
| `make deploy DOMAIN=... PROFILE=...` | Full deploy — creates infra if missing, updates binary + config |
| `make deploy-update DOMAIN=... PROFILE=...` | Push new binary/config only — skips infra |

### SSH access and logs

```bash
ssh -i ~/.ssh/openclaw-wa.pem ec2-user@<Public IP>
ssh -i ~/.ssh/openclaw-wa.pem ec2-user@<Public IP> 'journalctl -u wa-server -f'
```

---

## Store drivers

| `STORE_DRIVER` | Persistence | Use case |
|:---|:---|:---|
| `sqlite` | Single `.db` file with WAL mode (default) | Local dev, single-VM cloud deploy |
| `file` | JSON file on disk | Legacy / very-small deployments |
| `memory` | In-process only, lost on restart | Unit tests, throwaway dev |

Configure in `.env`:

```bash
# SQLite (default) — no external server, WAL for concurrent reads
STORE_DRIVER=sqlite
STORE_FILE_PATH=./data/store.db      # .db suffix is appended if omitted

# JSON file
STORE_DRIVER=file
STORE_FILE_PATH=./data/store.json
```

---

## 24-hour customer service window

WhatsApp only permits free-form outbound messages within 24 hours of the user's last inbound. **360dialog silently accepts sends past that window** (HTTP 200 + wamid) but WhatsApp discards them downstream, so a naive integration loses messages with no error signal.

The backend enforces the window itself:

1. Every user-initiated webhook stamps `last_inbound_at` on the pairing record.
2. Before `/api/v1/send` calls the provider, it checks `now - last_inbound_at >= WINDOW_HOURS` (default `23h`). If stale, it skips the provider entirely and dispatches a re-engagement template (`REENGAGEMENT_TEMPLATE_NAME`) with a quick-reply button; the send response becomes `{"status":"window_closed","templateSent":…}` instead of `accepted`.
3. Template sends are throttled per `(wab, phone, template)` for `TEMPLATE_THROTTLE_HOURS` (default `24h`) so a chatty agent can't spam.
4. When the user taps the template's **Read Now** button, the backend WS-broadcasts `WINDOW_OPENED` to the paired plugin instance — which flushes its local buffer of any messages queued while the window was closed.

Relevant env vars (all optional, sane defaults):

| Var | Default | Purpose |
|:---|:---|:---|
| `WINDOW_HOURS` | `23` | Client-side window guard. `0` disables the proactive check. |
| `TEMPLATE_THROTTLE_HOURS` | `24` | Per-(wab, phone, template) send cooldown. |
| `REENGAGEMENT_TEMPLATE_NAME` | `smart_session_20260521` | 360dialog / Meta-approved template. |
| `REENGAGEMENT_TEMPLATE_LANG` | `en` | BCP-47 template language. |
| `REENGAGEMENT_BUTTON_PAYLOAD` | `OPENCLAW_READ_NOW` | Payload override that maps the button tap to `WINDOW_OPENED`. |

Both plugins understand the `window_closed` response contract; the Claude Code plugin additionally persists a per-phone buffer in `WA_BUFFER_DIR` and drains it on the next `WINDOW_OPENED`.

---

## Pairing modes

Each backend pairing carries a `pairing_mode`:

| Mode | Behaviour |
|:---|:---|
| `single_use` (default) | A fresh `CLAW-XXXX-YYYY` code is minted per pairing request and expires after `PAIRING_CODE_TTL_SECONDS`. One code = one phone. Used by both `make pair` and the plugins' first-run setup wizards. |
| `persistent` | An **invite** — one code, one instance, unlimited phones. Any phone that texts the code becomes an active pairing under the same instance/API key. Useful for shared/team bots where you want to hand out one QR to many devices. Manage via `POST /api/v1/pair/request {"mode":"persistent"}`, `GET /api/v1/pair/invite`, `DELETE /api/v1/pair/invite/{inviteId}`. |

---

## Backend API

| Endpoint | Method | Auth | Description |
|:---|:---|:---|:---|
| `/healthz` | GET | — | Health check |
| `/api/v1/pair/request` | POST | — | Generate pairing code + API key. Body: `{"mode":"single_use"\|"persistent"}` (default `single_use`) |
| `/api/v1/pair/invite` | GET | Bearer | Fetch active persistent invite for this API key |
| `/api/v1/pair/invite/{inviteId}` | DELETE | Bearer | Revoke a persistent invite |
| `/api/v1/pair/status` | GET | Bearer | Check pairing status |
| `/api/v1/send` | POST | Bearer | Send outbound text or media. Returns `{"status":"accepted","messageId":…}` or `{"status":"window_closed","templateSent":…}` |
| `/api/v1/send-media` | POST | Bearer | Multipart file upload — sends via provider without needing a public URL |
| `/api/v1/typing` | POST | Bearer | Mark message read + show typing indicator |
| `/api/v1/media/{mediaId}` | GET | Bearer | Download inbound media (proxied from provider) |
| `/webhooks/whatsapp` | GET | — | Meta webhook registration challenge |
| `/webhooks/whatsapp` | POST | HMAC/Header | Receive inbound events from Meta / 360dialog |
| `/ws` | WSS | Bearer | WebSocket — inbound event stream to plugin |

---

## WhatsApp providers

Set `WA_PROVIDER` in `.env`:

| Value | Provider | Required vars |
|:---|:---|:---|
| `360dialog` | 360dialog Cloud API | `D360_API_KEY` |
| `meta` | Meta WhatsApp Cloud API | `WABA_TOKEN`, `WABA_PHONE_NUMBER_ID` |
| `` (empty) | Stub / dev mode | — |

---

## OpenClaw plugin

### Install

```bash
# Dev link (no copy)
openclaw plugins install -l ./openclaw-plugin
openclaw gateway restart

# From npm / ClawHub (after publishing)
openclaw plugins install openclaw-channel-whatsapp-official
```

### Supported message types

| Type | Agent receives |
|:---|:---|
| Text | Plain text |
| Image | Base64 data URI (`data:image/jpeg;base64,...`) — readable by vision models |
| Video / Audio / Sticker | `[type] · filename · mime · N KB` |
| Document | `[document] · filename · mime · N KB` |

### Publishing (npm + ClawHub)

Bump `version` in **both** `openclaw-plugin/package.json` and `openclaw-plugin/openclaw.plugin.json`, then:

```bash
./scripts/publish-plugin-npm-clawhub.sh
```

---

## Claude Code plugin

Forwards each paired WhatsApp user into their own persistent Claude Code CLI session. Each turn spawns `claude -p "<prompt>" --resume <session-id>` with the workspace pinned to `./workspaces/<phone>/`, so the agent has continuous conversational memory *and* a per-user sandboxed filesystem to read/write in.

### Install & pair

From npm (no clone needed):

```bash
npx claude-whatsapp-official-plugin setup   # pairs WhatsApp, writes .env, starts the bridge
npx claude-whatsapp-official-plugin start   # subsequent runs
```

Or from a checkout of this repo:

```bash
cd claude-plugin
npm run setup                               # first-run: install deps, pair, write .env, start
npm start                                   # subsequent runs
```

**Prerequisites:** Node.js ≥ 22.6 (uses `--experimental-strip-types` to run TypeScript directly), plus a `claude` CLI already logged in on the host — the bridge inherits its auth.

### Features specific to the Claude Code bridge

- **Per-user workspaces** at `./workspaces/<phone>/`, seeded from `workspace-template/`. The agent's file operations stay isolated per WhatsApp user.
- **Streaming intermediate output** to WhatsApp while Claude is working (toggle with `CLAUDE_STREAM_INTERMEDIATE`).
- **`send-wa` CLI** inside each workspace — Claude can call `./send-wa "text"` from a skill/hook to push a message back to the paired user (buffer-aware: falls back to the local buffer if the window is closed).
- **Local buffer** in `WA_BUFFER_DIR` for `window_closed` sends; drains automatically when the backend broadcasts `WINDOW_OPENED` (user tapped the re-engagement template).
- **Permission modes** via `CLAUDE_PERMISSION_MODE` (`default` / `acceptEdits` / `bypassPermissions` / `plan`). WhatsApp is unattended — if Claude needs a permission prompt and nobody's at the terminal, the turn stalls, so pick consciously.

See [`claude-plugin/README.md`](./claude-plugin/README.md) for the full env reference and turn-by-turn flow diagram.

---

## Make targets

```
make up                    Start local backend (Docker)
make down                  Stop local backend
make smoke                 Run smoke tests
make pair                  Request a pairing code
make ws API_KEY=imbee_xxx  Open WebSocket listener
make send API_KEY=imbee_xxx TEXT="hello"  Send outbound message
make test                  Run Go tests
make ngrok                 Start ngrok + register 360dialog webhook

make publish-plugin-local                   Patch ROUTING_BASE_URL into plugin for local dev (no publish)
make publish-plugin-local BAKE_ENV_FILE=.env.dev  Same, with explicit env file
make publish-plugin-npm-clawhub             Publish plugin to npm + ClawHub
make publish-plugin-npm-clawhub ENV_FILE=.env.prod  Publish using prod env

make aws-login             Authenticate with imBee AWS SSO (prod)
make aws-login DEV=1       Authenticate with imBee AWS SSO (dev)
make deploy DOMAIN=...     Full deploy to EC2
make deploy-update DOMAIN=...  Push binary/config to existing instance
```
