# OpenClaw Official WhatsApp Plugin

> **Looking to install the OpenClaw plugin?** See [`openclaw-plugin/README.md`](./openclaw-plugin/README.md) for end-user installation, FAQ, and plan details.
>
> **Want to forward WhatsApp into a Claude Code session?** See [`claude-plugin/README.md`](./claude-plugin/README.md).

This repo contains the backend routing server plus one or more agent plugins that bridge WhatsApp (via imBee) to a locally-running AI agent. The backend is agent-agnostic — it speaks a small WebSocket + HTTP contract that any plugin can consume.

**Repo layout:**

| Path | Description |
|:---|:---|
| `backend/` | Go routing server — pairing, webhook verification, WebSocket hub, media proxy (agent-agnostic) |
| `openclaw-plugin/` | OpenClaw channel plugin — runs inside the OpenClaw gateway |
| `claude-plugin/` | Claude Code bridge — forwards each paired WhatsApp user to their own Claude Code session |
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

### 5. Install the plugin into OpenClaw

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

### 6. Test

Send a WhatsApp message to the shared number — your OpenClaw agent should reply.

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
| `file` | JSON file on disk (default) | Local dev, single-VM cloud deploy |
| `memory` | In-process only, lost on restart | Unit tests, throwaway dev |
| `postgres` | PostgreSQL | Multi-replica production |

Configure in `.env`:

```bash
# File store (default)
STORE_DRIVER=file
STORE_FILE_PATH=./data/store.json

# Postgres
STORE_DRIVER=postgres
POSTGRES_DSN=postgres://postgres:postgres@localhost:5432/whatsapp_plugin?sslmode=disable
```

---

## Backend API

| Endpoint | Method | Auth | Description |
|:---|:---|:---|:---|
| `/healthz` | GET | — | Health check |
| `/api/v1/pair/request` | POST | — | Generate pairing code + API key |
| `/api/v1/pair/status` | GET | Bearer | Check pairing status |
| `/api/v1/send` | POST | Bearer | Send outbound text or media |
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
