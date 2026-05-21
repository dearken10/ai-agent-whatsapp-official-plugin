# Technical Implementation Plan: Official WhatsApp Plugin for OpenClaw

## 1. Scope recap

You are building **two deliverables**:

1. **Local plugin** (`openclaw-channel-whatsapp-official` on npm / ClawHub): OpenClaw-native channel + setup wizard, WSS to imBee, REST for outbound.
2. **Central routing service** (imBee): Meta credentials, webhooks, pairing, mapping DB, WebSocket fan-out, optional 24h queue, rate limits.

Meta **Cloud API** and **WhatsApp conversation pricing** are the same whether traffic hits AWS or Azure; only **imBee's hosting** differs.

---

## 2. High-level architecture (implementation view)

```mermaid
flowchart LR
  subgraph user_machine [User machine]
    OC[OpenClaw + plugin]
  end
  subgraph imbee [imBee cloud]
    API[HTTPS API]
    WS[WSS /ws]
    WH[/webhooks/whatsapp]
    SVC[Routing service]
    DB[(Store: SQLite / file / memory)]
    Q[(Ephemeral queue / cache)]
  end
  subgraph meta [Meta]
    WA[WhatsApp Cloud API]
  end
  OC -->|pair/request, send, Bearer| API
  OC <-->|events, PAIRING_COMPLETE| WS
  WA -->|webhooks| WH
  WH --> SVC
  SVC --> DB
  SVC --> Q
  SVC --> WA
```

---

## 3. Technical plan by component

### 3.1 OpenClaw plugin (local)

| Area | Implementation |
|------|----------------|
| **Package** | npm package + `openclaw.plugin.json`; `configSchema` covers `routingBaseUrl`, `instanceId`, `apiKey`, `inviteId`, `dmPolicy`, `allowFrom`, `dmDenyMessage`, `groupPolicy`, `defaultTo`. |
| **Lifecycle** | `defineChannelPluginEntry` → `ChannelPlugin`; gateway account started via `startWhatsappOfficialGatewayAccount`. |
| **Setup wizard** | Step flow (`onboarding.ts`): imBee intro note → routing server URL → **mode selector** (`single_use` / `persistent`) → `POST /api/v1/pair/request {mode}` → render QR + `wa.me` URL. **Single-Use:** `prompter.confirm` waits for user to confirm scan. **Persistent Invite:** displays share instructions and exits immediately — no blocking wait. Both paths write `routingBaseUrl`, `instanceId`, `apiKey` to config; persistent mode also writes `inviteId`. Security note is shown in both paths. |
| **Config persistence** | `apiKey` and `inviteId` written directly into OpenClaw config YAML by the wizard return value. `inviteId` is used by the `DELETE /api/v1/pair/invite/{inviteId}` revoke flow. |
| **WebSocket client** | Persistent connection in `gateway.ts` with exponential backoff + jitter (cap 60s). Handles `INBOUND_MESSAGE` → `handleWhatsappOfficialInbound`, and `PAIRING_COMPLETE` → logs `phone`, `pairingMode`, `inviteId`. Auth: `Authorization: Bearer {apiKey}`. |
| **WS auth fallback** | Server accepts connections from both device-mapped API keys and invite-only API keys (instance with no paired phone yet). |
| **Outbound** | Agent reply → `POST /api/v1/send {toPhoneNumber, text}` with Bearer; `sendOutboundText` / `sendOutboundMedia` in `transport.ts`. |
| **Sender allowlist** | `inbound.ts` checks `dmPolicy === "allowlist"` before typing indicator; blocked senders receive `dmDenyMessage` reply via `sendOutboundText`, then handler returns. SDK backstop also enforced at routing layer. |
| **TLS** | HTTPS/WSS in production; dev uses `http://localhost:28080`. |
| **Tests** | Unit: code format, `wa.me` URL (AC-03), mode selector renders correctly (AC-16); integration: mock server for single-use pairing (AC-04, AC-06), persistent invite multi-phone (AC-18, AC-19), brute-force flows (AC-23, AC-24, AC-25). |

### 3.2 Routing server (imBee backend)

| Area | Implementation |
|------|----------------|
| **HTTP surface** | `POST /api/v1/pair/request` (with `mode` field), `GET /api/v1/pair/status`, `GET /api/v1/pair/invite`, `DELETE /api/v1/pair/invite/{inviteId}`, `POST /api/v1/send`, `POST /api/v1/typing`, `GET /api/v1/media/{mediaId}`, `GET+POST /webhooks/whatsapp`, `GET /ws`, `GET /healthz`. |
| **Webhook handler** | Verify HMAC-SHA256 signature (`X-Hub-Signature-256`) → respond 200 immediately → parse payload → call `routeIncoming` per message. |
| **Pairing — Single-Use** | CSPRNG codes `CLAW-[A-Z0-9]{4}-[A-Z0-9]{4}`, TTL configured via `PAIRING_CODE_TTL_SECONDS` (default 600s); code stored in `pairing_records.pairing_code`; cleared on first use via `ActivatePairing`; rate-limited via `TrackPairRequest`. Collision retry: up to 5 attempts on store error before returning error. |
| **Pairing — Persistent Invite** | Same code format; stored in `persistent_invites` with no expiry; code never cleared on use; revocable via `DELETE /api/v1/pair/invite/{inviteId}` which sets `revoked_at`. Same 5-retry policy on code collision. |
| **Webhook code dispatch** | Regex check (`CLAW-[A-Z0-9]{4}-[A-Z0-9]{4}`) → global RPM check → per-phone block check → **(A) try `ActivatePairing`** (single-use path); on code-not-found → **(B) try `FindInviteByCode`** + `ActivatePersistentPairing` (persistent path). Wrong code on both branches → record attempt → potentially block phone → send WA error reply. |
| **Brute-force prevention** | Two layers in-process (not persisted, cleared on restart): (1) **Global RPM cap** — sliding 1-minute window of code-format messages; drops silently above `BRUTE_FORCE_GLOBAL_RPM` (default 60). (2) **Per-phone block** — rolling window of wrong attempts; after `BRUTE_FORCE_MAX_ATTEMPTS` (default 5) within `BRUTE_FORCE_WINDOW_SECONDS` (default 3600), phone is blocked for `BRUTE_FORCE_BLOCK_MINUTES` (default 30); exactly one WA notification sent per block period via `bfPhoneNotified` map. Per-code counting not implemented — see PRD §8.6. |
| **WS authentication** | Bearer token verified at connect: checks `pairing_records` first (via `recordCache` then store); falls back to `persistent_invites` (`inviteCache` then store) to support instances with no paired phone yet. |
| **WS hub** | In-memory `ws.Hub` maps `instanceId → *websocket.Conn`; `Send` marshals JSON envelope and writes. Multiple connections per instance supported. |
| **Send validation** | `handleSend` looks up target by **phone number** (`FindByPhone`) then verifies `record.APIKey == requestApiKey`; this supports persistent mode where multiple phones share one API key. |
| **In-process caches** | `recordCache` (by phone + apiKey) and `inviteCache` (by code + apiKey) serve hot-path lookups without store round-trips. `inviteCache.evict` removes stale entries on revoke. |
| **Store drivers** | Three interchangeable drivers behind `store.Repository`: `memory` (default dev, no persistence), `file` (JSON file, atomic write-rename), `sqlite` (WAL mode, default prod). Selected via `STORE_DRIVER` env var. SQLite applies `tryAddColumn` migrations for safe upgrades of existing databases. |
| **Persistence** | `pairing_records` + `persistent_invites`; `pair_requests` for rate limiting. **No message bodies stored** (AC-09). |
| **Observability** | Structured log lines at each routing decision point (pairing, dispatch, brute-force events), masked phone numbers in logs. |
| **Ops** | WA provider selected via `WA_PROVIDER` (`meta`, `360dialog`, or stub). Credentials via env vars; designed for injection via cloud secret manager. |

### 3.3 Persistent Invite — detailed data flow

```
Plugin wizard (onboarding.ts)
  POST /api/v1/pair/request { mode: "persistent" }
    → pairing.Service.CreatePersistentInvite(clientIP)
      → rate-limit check (TrackPairRequest)
      → generate api_key + code (up to 5 retries on collision)
      → store.CreateInvite(invite)
    → returns { mode, apiKey, pairingCode, inviteId, waMeUrl, wabNumber }
  Wizard renders QR + displays share instructions
  Wizard exits immediately (no prompter.confirm wait)
  Plugin writes apiKey + inviteId to OpenClaw config

Gateway starts (gateway.ts)
  WebSocket connects to /ws with Bearer apiKey
    → server checks pairing_records (none yet)
    → fallback: server checks persistent_invites → match → instanceId resolved
  Connection registered in ws.Hub[instanceId]

Phone A sends "CLAW-A3F9-Z7KL" to shared WA number
  Webhook arrives → routeIncoming(msg)
    → code matches regex
    → global RPM check passes
    → per-phone block check passes
    → ActivatePairing(code) → "pairing code not found" (it's an invite code)
    → FindInviteByCode(code) → invite found (revoked_at IS NULL)
    → ActivatePersistentPairing(invite, phoneA, now)
        → evict existing active record for phoneA on same wab_number
        → INSERT pairing_records { phone_number=A, pairing_mode="persistent", invite_id }
    → send WA confirmation to Phone A
    → ws.Hub.Send(instanceId, PAIRING_COMPLETE { phoneNumber: A, pairingMode: "persistent", inviteId })

Phone B sends same code
  → same flow → new pairing_records row for Phone B (phoneA record unchanged)
  → PAIRING_COMPLETE fires again with phoneNumber: B

Revoke:
  DELETE /api/v1/pair/invite/{inviteId}  (Authorization: Bearer apiKey)
    → verify invite.APIKey == requestApiKey
    → store.RevokeInvite(inviteId, now)  →  UPDATE persistent_invites SET revoked_at = now()
    → inviteCache.evict(inviteId)
    → existing pairing_records rows remain ACTIVE (phones keep their connection)
    → future code sends no longer match (FindInviteByCode filters WHERE revoked_at IS NULL)

Note: existing paired phones are not disconnected on invite revoke; they remain active until
they re-pair or the instance operator manually manages them. This is intentional for v1 — a
future "revoke and disconnect all" endpoint can set pairing_records.status = DISCONNECTED
WHERE invite_id = inviteId and call ws.Hub.Disconnect(instanceId) for a hard cutoff.
```

### 3.4 Meta integration

- Register app webhook URL → imBee `POST /webhooks/whatsapp`.
- Outbound: Cloud API sends using imBee's phone number ID / tokens (server-only).
- Document **conversation window** and Meta billing in runbooks (not cloud-specific).

---

## 4. Phased delivery

| Phase | Outcome | Status |
|-------|---------|--------|
| **P0 – Contracts** | OpenAPI (or shared TS types) for REST + WSS message shapes; error codes for wizard; `mode` field and `persistent_invites` schema. | ✅ Done |
| **P1 – Routing MVP** | Webhook verify + parse + single-use pairing path + DB + minimal `send` + WSS `PAIRING_COMPLETE`. | ✅ Done |
| **P2 – Plugin MVP** | Wizard with mode selector + WSS + channel adapter calling mock then real server. | ✅ Done |
| **P3 – Persistent Invite** | `persistent_invites` table; `POST /api/v1/pair/request {mode}` two-branch dispatch; `GET`/`DELETE /api/v1/pair/invite`; extended `PAIRING_COMPLETE`; invite cache; WS auth fallback; wizard exits immediately for persistent mode; `inviteId` written to config. | ✅ Done |
| **P4 – Brute-Force & Sender Filtering** | Per-phone block + global RPM cap (in-process); `dmPolicy: allowlist` enforcement with `dmDenyMessage` reply in plugin; security note in wizard and README. | ✅ Done |
| **P5 – Resilience** | 24h queue, DISCONNECTED state, user-visible "missed messages" path. | ⬜ Planned |
| **P6 – Hardening** | Security review (AC-07, AC-09, AC-20, AC-21); load test AC-05; move brute-force counters to persistent store for crash-safety; "revoke and disconnect all" endpoint; Media forwarding hardening. | ⬜ Planned |

---

## 5. Suggested implementation stacks (both clouds)

**Application runtime:** Go — single binary, low memory per goroutine, strong WS + JSON ecosystem.

**Database:** Three interchangeable store drivers behind `store.Repository`:

| Driver | Use case | Selected via |
|--------|----------|--------------|
| `memory` | Unit tests, ephemeral dev | `STORE_DRIVER=memory` |
| `file` | Single-process dev with persistence | `STORE_DRIVER=file` |
| `sqlite` | Default production (no external DB required) | `STORE_DRIVER=sqlite` (default) |

For multi-instance production scale, replace with **PostgreSQL** (RDS / Azure Database for PostgreSQL Flexible Server) — the `store.Repository` interface makes this a new driver addition, not a refactor.

**Queue / ephemeral store:**
- AWS: SQS (visibility + DLQ) or Redis (ElastiCache) for short TTL semantics you control.
- Azure: Service Bus (sessions/TTL) or Azure Cache for Redis.

**Comparable reference architectures**

- **AWS (hybrid):** API Gateway **WebSocket** for `/ws` + **HTTP API** or ALB for REST + webhook; **Lambda** or **ECS Fargate** for handlers; **RDS PostgreSQL**; **SQS**; **Secrets Manager**.
- **AWS (uniform containers):** **ECS Fargate** + **ALB** (HTTP + WebSocket upgrade on same app) simplifies one codebase, one scaling model.
- **Azure:** **Container Apps** (HTTP + WebSocket on same revision) + **Azure Database for PostgreSQL** + **Service Bus** or Redis + **Key Vault**.

---

## 6. Azure vs AWS cost comparison

**Important:** Dollar figures are **order-of-magnitude estimates** for planning. Use [AWS Pricing Calculator](https://calculator.aws/) and [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) with your region and sustained connection counts.

### 6.1 Shared assumptions (example "early production")

| Assumption | Value |
|------------|--------|
| Concurrent WebSocket clients (paired instances) | **1,000** |
| Hours connected per client per day | **12** |
| Inbound + outbound WS **application** messages per client per day (heartbeats excluded where possible) | **600** total (similar scale to AWS's published chat example) |
| Meta webhooks + REST (`pair`, `send`) per month | **5M** requests (order of ~few per message + overhead) |
| PostgreSQL | **db.t4g.micro**-class / **B1ms**-class, single AZ, small storage |
| Ephemeral queue | modest footprint (mostly small JSON, 24h cap) |

### 6.2 AWS — WebSocket-centric split (API Gateway WebSocket + small compute)

From [Amazon API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/) (WebSocket example pattern):

- **Connection minutes:** 1,000 × 12 × 60 × 30 ≈ **21.6M min/month** → about **21.6 × $0.25/million ≈ $5.40**/month for connectivity (same formula as AWS's 1000-user × 12h example).
- **Messages:** 600 × 1,000 × 30 ≈ **18M messages/month** → about **18 × $1.00/million ≈ $18**/month (first billion tier).

So **API Gateway WebSocket alone** is often **~$20–30/month** at this scale **before** Lambda/ECS, RDS, NAT, and data transfer.

Add rough monthly **indicative** extras (vary by region and tuning):

| Line item | Rough range |
|-----------|-------------|
| RDS PostgreSQL (small) | ~$15–40 |
| Lambda or light Fargate for webhook/API glue | ~$10–80 |
| SQS + Secrets Manager + CloudWatch | ~$5–25 |
| Data transfer / NAT (if Lambda in VPC) | **$0–50+** (NAT can dominate if not careful) |

**AWS total (indicative):** roughly **$50–150/month** at this toy scale; **NAT gateways and high API Gateway REST volume** can push it higher.

### 6.3 Azure — Container-centric (Container Apps + PostgreSQL)

Azure typically **does not bill WebSocket the same way as API Gateway** when it is **inbound to your container**; you pay mainly for **vCPU-GB-seconds**, requests, and **ingress** (see [Azure Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)).

For a **single small always-on revision** (e.g. 0.25 vCPU, 0.5 GiB, 1 min replica) handling 1k WS + webhooks:

| Line item | Rough range |
|-----------|-------------|
| Container Apps (always-on small replica) | ~$30–90 (highly region/plan dependent) |
| Azure Database for PostgreSQL Flexible Server (Burstable small) | ~$15–50 |
| Service Bus / Redis (small) | ~$10–40 |
| Key Vault + monitoring | ~$5–15 |

**Azure total (indicative):** often **~$60–180/month** for a similar early footprint, with **less discrete "per WebSocket message"** line item than AWS API Gateway WebSocket.

### 6.4 Head-to-head summary

| Dimension | AWS | Azure |
|-----------|-----|-------|
| **WebSocket pricing model** | Very explicit: **$0.25/million connection-minutes** + **$1/million messages** (WebSocket API) | Usually folded into **container consumption** + ingress; fewer discrete WS meters |
| **Likely winner at "many long-lived WS + moderate messages"** | Can be **cheap and predictable** if you use **API Gateway WebSocket** at moderate scale (per AWS examples) | Can be **competitive** if one **Container App** holds connections efficiently |
| **Risk of bill spikes** | High **REST** volume on API Gateway REST pricing; **NAT** in VPC | Mis-sized **always-on** replicas; **Premium** messaging tiers |
| **Operational fit** | Strong if you already use Lambda/API GW ecosystem | Strong if team is Microsoft-centric and wants **Container Apps** + **Flexible Server** |

**Practical recommendation for cost engineering**

- **AWS:** Prefer **one ECS Fargate service + ALB** (WebSocket + HTTP together) *or* **API Gateway WebSocket + Lambda** — model both in the calculator; the second splits cost clearly but adds integration complexity.
- **Azure:** Model **Container Apps** with your expected **min replicas** and **concurrent connections**; WebSocket load often maps to **compute**, not a separate message meter.

---

## 7. What the PRD leaves for product/engineering (tie-in to §12)

- Throughput targets → instance size and rate limits.
- Unpair UX and retention/GDPR → schema and deletion jobs.
- Multi-agent routing → out of v1 per PRD non-goals.

---

## 8. References from the PRD

- OpenClaw plugin architecture: [docs.openclaw.ai/plugins/architecture](https://docs.openclaw.ai/plugins/architecture)
- Meta webhooks: [developers.facebook.com/.../webhooks/overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)

---

## 9. Node.js vs Go Cost Sensitivity

Language choice usually impacts **compute efficiency**, not managed service pricing. For this architecture, the biggest variable is how many long-lived WebSocket connections each runtime can handle per vCPU and per GiB RAM.

### 9.1 What language does and does not change

- **Usually unchanged:** API Gateway/WebSocket metered pricing, DB tier list prices, queue pricing, storage pricing, Meta WhatsApp conversation charges.
- **Potentially improved with Go:** lower memory footprint, steadier CPU under high concurrency, smaller container/VM sizing for the same throughput.
- **Result:** language may lower the **compute component** materially, but total system savings are moderated by fixed costs (DB, secrets, observability, base networking).

### 9.2 Scenario table (order-of-magnitude planning)

| Scenario | Typical runtime pressure | Expected total monthly savings with Go vs Node.js | Notes |
|----------|---------------------------|---------------------------------------------------|-------|
| **Low concurrency MVP** (tens of concurrent users) | light CPU, low memory | **~0-10%** | Fixed costs dominate; difference may be single-digit dollars. |
| **Medium concurrency** (hundreds of concurrent users) | moderate WS fan-out + webhook handling | **~5-20%** | Compute share grows; Go often allows a smaller instance class. |
| **High concurrency** (thousands+ long-lived WS) | memory and scheduler pressure | **~15-35%** | Language/runtime efficiency matters more; validate with load tests. |

### 9.3 Practical estimate for this document's MVP ranges

- From the earlier planning ranges:
  - **AWS total:** ~$50-150/month
  - **Azure total:** ~$60-180/month
- A realistic Go-over-Node savings band is often **~$5-30/month** at this scale.
- The most reliable savings still come from:
  - right-sizing PostgreSQL tier,
  - minimizing always-on idle replicas,
  - avoiding unnecessary NAT/data-transfer paths,
  - and reducing nonessential managed services early.

### 9.4 Recommendation

If the team is equally productive in both languages, **Go is a cost-efficient default** for a WebSocket-heavy routing service. If Node.js accelerates delivery significantly, shipping with Node.js first and optimizing infra topology can still outperform a slower Go timeline economically.

---

If needed, this can be split next into:
- `implementation-roadmap.md` (engineering work breakdown)
- `cost-model.xlsx` equivalent assumptions table for CFO/ops review
