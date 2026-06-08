# Product Requirements Document
## 24-Hour Window Handling and Plugin-Local Buffering (Failure-Driven)

**Feature:** `wa-24h-window`
**Author:** imBee Limited
**Status:** Draft v0.4
**Date:** 2026-06-01
**Depends on:** `docs/prd/product-requirements-document.md` (channel plugin v1.3)

---

## 1. Executive Summary

WhatsApp Cloud API enforces a **24-hour customer service window**: outside the 24 hours since the user's last inbound message, only **pre-approved templates** may be sent. Today, the routing server's `/api/v1/send` calls the provider unconditionally; the provider rejects with `(#131047) Re-engagement message` and the message is lost silently.

This PRD specifies a minimal, failure-driven fix:

1. The routing server does **not** track window state. It simply attempts the send.
2. When the provider rejects with a 24h-window error, the routing server makes a best-effort attempt to send the pre-approved re-engagement template (`smart_session_20260521`, "You have unread message(s)" + `Read Now` quick-reply button) and returns `window_closed` to the plugin.
3. **Each template send costs money** (WhatsApp utility-template pricing). The routing server enforces a **persistent 24-hour throttle** per `(wab, phone, template)`: if the same pair already received the template within the last 24h, the server skips the send and returns `templateSent: false`. This is the only new persistent state on the server — a single timestamp row, no message content.
4. The plugin (openclaw-plugin or claude-plugin) **buffers the original message locally** in its workspace.
5. When the user replies (any inbound message, or tapping `Read Now`), the routing server forwards the inbound to the plugin over WebSocket as today. The plugin sees there are buffered messages for that phone and **flushes them by re-calling `/api/v1/send`** before handing the inbound to the agent.
6. While the local buffer for a phone is non-empty, the plugin enqueues subsequent outbound messages **directly to disk** without calling `/api/v1/send`. This avoids wasteful round-trips. The server-side throttle from (3) is the authoritative cost guard; the plugin-side check is efficiency.

The parent PRD's data-minimisation rule (§8.4) is preserved: message bodies live only on the operator's own machine. The new server-side row holds a timestamp only — no agent-produced content.

---

## 2. Problem Statement

- `/api/v1/send` (in `backend/internal/http/handlers.go:handleSend`) calls `Provider.SendText` / `Provider.SendMedia` unconditionally and surfaces provider errors as plain 5xx.
- The agent has no signal that "your reply was rejected because the user has been silent for 24h."
- There is no re-engagement mechanism. Users miss async agent updates.

The fix needs to (a) detect the 24h failure, (b) re-engage via template, (c) keep the message safe until the window reopens, (d) deliver in order when it does — without storing operator content centrally.

---

## 3. Goals and Non-Goals

### 3.1 Goals

- Never silently drop an outbound message because of a 24h-window rejection.
- On detection of a 24h-window rejection, dispatch the re-engagement template best-effort and tell the plugin to buffer.
- **Enforce a 24h server-side cooldown per `(wab, phone, template)` so each user receives at most one billable template per day**, regardless of plugin behaviour.
- Buffer original message bodies **only on the operator's own machine** (plugin workspace).
- Flush in original order the moment the window reopens.
- Keep the change additive on the `/api/v1/send` contract: a new `window_closed` status next to the existing `accepted`.
- Limit new server-side persistence to a single metadata row (timestamp only); never store agent message content.

### 3.2 Non-Goals

- **Pre-emptive window tracking.** No `last_inbound_at` column, no `window_state` table. The provider's error response is the only signal that triggers buffering.
- **Server-side buffering of agent content.** No `buffered_messages` table on the backend. The only new server-side row is the template-throttle timestamp (see §7.3).
- **Template approval workflow.** `smart_session_20260521` is already approved in the dev WABA (verified 2026-06-01).
- **Multi-template support.** v1 sends exactly one template name, server-configured.
- **Per-instance template override.**
- **Window state probe / poll on plugin startup.**
- **Group messaging.**

---

## 4. User Stories

| # | As a... | I want... |
| :- | :- | :- |
| US-01 | WhatsApp user | One polite nudge ("You have unread message(s)" + `Read Now`) when my agent has something queued |
| US-02 | WhatsApp user | Only **one** nudge per silent episode, not one per buffered message |
| US-03 | WhatsApp user | Tapping `Read Now` delivers everything the agent queued, in order |
| US-04 | Agent author | A `/api/v1/send` response of `{ status: "queued" }` (from the plugin) when a message is buffered — never a raw error to handle |
| US-05 | Operator | Buffered messages survive plugin restart |

---

## 5. User Flow

### 5.1 Window open

```
Agent → plugin.send(msg)
  → plugin: buffer for (wab, to) is empty
  → POST /api/v1/send → 200 { status: "accepted", messageId }
  → returns { status: "delivered", messageId } to agent
```

### 5.2 Window closed — first message of an episode

```
Agent → plugin.send(msg)
  → plugin: buffer for (wab, to) is empty
  → POST /api/v1/send
    → Backend: Provider.SendText → 24h error
    → Backend: Provider.SendTemplate(smart_session_20260521, en) ← best effort
    → 200 { status: "window_closed", templateSent: true|false }
  → plugin: append msg to <workspace>/wa-buffer/<wab>/<phone>.jsonl
  → returns { status: "queued", localId } to agent
```

### 5.3 Window closed — subsequent messages

```
Agent → plugin.send(msg)
  → plugin: buffer for (wab, to) is NON-empty
  → skip the /api/v1/send call entirely
  → append msg to local buffer
  → returns { status: "queued", localId } to agent
```

This is the implicit throttle: as long as the plugin holds buffered messages, it does not retry the API, so the backend does not re-send the template.

### 5.4 User replies

```
Meta / 360dialog webhook → backend
  → backend: forward INBOUND_MESSAGE to plugin (existing behaviour)

Plugin (WS handler):
  → flushBuffer(wab, from):
       for each entry in buffer (oldest first):
         POST /api/v1/send
         → 200 accepted → drop entry from buffer
         → 200 window_closed → stop (window re-closed somehow)
         → 5xx / network → increment attempts; stop
  → dispatch INBOUND_MESSAGE to the agent runtime
```

### 5.5 User taps `Read Now`

```
Webhook arrives with button payload = REENGAGEMENT_BUTTON_PAYLOAD
  → backend: do NOT forward as INBOUND_MESSAGE (suppress the synthetic event)
  → backend: push WS WINDOW_OPENED { wab, phone }

Plugin (WS handler):
  → flushBuffer(wab, phone)  // no agent dispatch
```

### 5.6 User never returns

```
Plugin sweeper (every WA_BUFFER_SWEEP_INTERVAL_MIN):
  → drop entries older than WA_BUFFER_TTL_HOURS
```

---

## 6. Architecture Changes

| Component | Change |
| :--- | :--- |
| `backend/internal/whatsapp/provider.go` | Add `SendTemplate(ctx, to, name, lang, components)` to the `Provider` interface. Implement on `meta`, `360dialog`, `stub`. |
| `backend/internal/whatsapp/{meta,dialog360}.go` | Detect 24h-window provider error (Meta: code `131047`; 360dialog: same code, same shape) and surface as a typed error (`ErrWindowClosed`) so handlers can branch. |
| `backend/internal/store/` | New `TemplateThrottleStore` (one row per `(wab, phone, template)` with a `last_sent_at` timestamp). Repository gains `WasTemplateSentRecently(wab, phone, template, within)` and `MarkTemplateSent(wab, phone, template, now)`. Implement on `memory`, `file`, `sqlite` drivers. |
| `backend/internal/http/handlers.go` — `handleSend` | On `ErrWindowClosed`: consult `TemplateThrottleStore`; if not recently sent, `SendTemplate` then `MarkTemplateSent`. Return `200 { status: "window_closed", templateSent }`. All other paths unchanged. |
| `backend/internal/http/handlers.go` — webhook | Detect button-reply payload equal to `REENGAGEMENT_BUTTON_PAYLOAD`; do not forward as `INBOUND_MESSAGE`, push a `WINDOW_OPENED` WS event instead. |
| `backend/internal/ws/hub.go` | New envelope type `WINDOW_OPENED { wab, phone }`. |
| `openclaw-plugin/src/buffer.ts` *(new)* | JSONL-backed local buffer module: `enqueue`, `listPending`, `markDelivered`, `recordFailure`, `sweepExpired`. |
| `openclaw-plugin/src/transport.ts` | Wrap `sendOutbound*` with the buffer-aware logic from §5.1–§5.3. |
| `openclaw-plugin/src/gateway.ts` | Wire `INBOUND_MESSAGE` and `WINDOW_OPENED` handlers to call `flushBuffer` before agent dispatch. |
| `claude-plugin/src/index.ts` (+ a new `buffer.ts`) | Same as above for the Claude bridge. |

**One new persistent table:** `template_throttle` (timestamp metadata only — see §7.3). No new content storage anywhere on the server.

---

## 7. Technical Specifications

### 7.1 Provider — `SendTemplate`

```go
// in backend/internal/whatsapp/provider.go
type TemplateComponent struct {
    Type       string              `json:"type"`        // "body" | "button"
    SubType    string              `json:"sub_type,omitempty"`
    Index      string              `json:"index,omitempty"`
    Parameters []TemplateParameter `json:"parameters,omitempty"`
}
type TemplateParameter struct {
    Type    string `json:"type"`              // "text" | "payload"
    Text    string `json:"text,omitempty"`
    Payload string `json:"payload,omitempty"`
}

SendTemplate(ctx context.Context, to, name, lang string, components []TemplateComponent) (messageID string, err error)
```

**360dialog body** (verified 2026-06-01 against dev WABA `+18064509684`, template `smart_session_20260521`, returned `HTTP 200 message_status: accepted`):

```json
{
  "messaging_product": "whatsapp",
  "to": "<phone>",
  "type": "template",
  "template": { "name": "smart_session_20260521", "language": { "code": "en" } }
}
```

POST to `${D360_BASE_URL}/messages` with header `D360-API-KEY: $D360_API_KEY`. The `meta` provider uses the same JSON shape against `graph.facebook.com/v19.0/{phone_number_id}/messages` with `Authorization: Bearer $WABA_TOKEN`. The `stub` provider returns `wamid.<uuid>` with no network IO.

### 7.2 Window-error detection

Both providers return Meta-style error JSON:

```json
{"error":{"code":131047,"message":"(#131047) Re-engagement message", ...}}
```

`backend/internal/whatsapp/{meta,dialog360}.go` parses send responses; when the error code is `131047` (or the error message matches `(#131047)`), the provider returns a sentinel error:

```go
var ErrWindowClosed = errors.New("whatsapp: 24h customer service window closed")
```

`handleSend` branches on `errors.Is(err, ErrWindowClosed)`.

### 7.3 Template throttle store (server-side)

To guarantee at most one billable re-engagement template per `(wab, phone, template)` in any 24-hour window — regardless of plugin behaviour, race conditions, or out-of-band callers — the routing server persists a single timestamp per pair+template.

**Table: `template_throttle`**

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `wab_number` | `VARCHAR(20)` | `NOT NULL` | Part of composite PK |
| `phone_number` | `VARCHAR(20)` | `NOT NULL` | Part of composite PK |
| `template_name` | `VARCHAR(64)` | `NOT NULL` | Part of composite PK; future-proofs for multi-template |
| `last_sent_at` | `TIMESTAMP` | `NOT NULL` | Last successful template dispatch to the provider |

PK: `(wab_number, phone_number, template_name)`. No secondary indexes — all reads are by PK.

This table holds **no message content**. Only timestamps and routing keys. Consistent with the parent PRD §8.4.

**`Repository` additions** (in `backend/internal/store/store.go`):

```go
WasTemplateSentRecently(wab, phone, template string, within time.Duration, now time.Time) (bool, error)
MarkTemplateSent(wab, phone, template string, now time.Time) error
```

Both methods are implemented on the `memory`, `file`, and `sqlite` drivers.

**Configurable throttle window:**

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `TEMPLATE_THROTTLE_HOURS` | `24` | Minimum hours between two template sends to the same `(wab, phone, template)` |

Default of 24h mirrors the WhatsApp window itself: at most one re-engagement per user per day.

### 7.4 `POST /api/v1/send` handler

```go
msgID, err := provider.SendText(ctx, to, text)
if err == nil {
    return 200 { status: "accepted", messageId: msgID }
}
if errors.Is(err, whatsapp.ErrWindowClosed) {
    templateSent := false
    recently, _ := store.WasTemplateSentRecently(wab, to,
        REENGAGEMENT_TEMPLATE_NAME, TEMPLATE_THROTTLE_HOURS, now)
    if !recently {
        if _, terr := provider.SendTemplate(ctx, to,
            REENGAGEMENT_TEMPLATE_NAME, REENGAGEMENT_TEMPLATE_LANG, nil); terr == nil {
            _ = store.MarkTemplateSent(wab, to, REENGAGEMENT_TEMPLATE_NAME, now)
            templateSent = true
        } else {
            log.Error("reengagement template failed", "err", terr)
        }
    } else {
        metrics.TemplateThrottled.Inc()
    }
    return 200 { status: "window_closed", templateSent }
}
return 5xx
```

The throttle is enforced **after** the throttle check but **before** the provider call, so a throttled second send incurs zero provider cost. `MarkTemplateSent` is only called on a successful provider response — a failed template send does not consume the throttle window, so the next attempt retries.

The race between concurrent `handleSend` invocations for the same `(wab, phone, template)` is resolved by the composite PK: the second `MarkTemplateSent` either no-ops (upsert) or returns a constraint error; in either case the database holds the most recent timestamp. **v1 accepts the tiny duplicate-send risk** — both calls may pass the `WasTemplateSentRecently` check inside a request-RTT-wide window and both reach `SendTemplate`. The plugin-side `hasPending` check already eliminates the race for all but the first message of a closed episode, so realistic frequency is ~zero. If production metrics surface duplicates, add `SELECT ... FOR UPDATE` around the check in a follow-up.

### 7.5 Webhook — button reply handling

In the webhook handler, after parsing the payload, detect button-reply events whose payload string equals `REENGAGEMENT_BUTTON_PAYLOAD`:

- Meta: `entry[].changes[].value.messages[].button.payload`
- 360dialog: `entry[].changes[].value.messages[].interactive.button_reply.id` (or the equivalent in 360dialog's webhook shape)

When matched:

- **Do not** forward as `INBOUND_MESSAGE` (suppress noise from the agent).
- Push `WINDOW_OPENED { wab, phone }` via the existing WS hub.

All other inbound events forward as `INBOUND_MESSAGE` exactly as today — no new envelope fields required.

### 7.6 Backend env vars

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `REENGAGEMENT_TEMPLATE_NAME` | `smart_session_20260521` | Template name registered with the provider |
| `REENGAGEMENT_TEMPLATE_LANG` | `en` | BCP-47 language code |
| `REENGAGEMENT_BUTTON_PAYLOAD` | `OPENCLAW_READ_NOW` | Button payload that triggers `WINDOW_OPENED` |
| `TEMPLATE_THROTTLE_HOURS` | `24` | Per-`(wab, phone, template)` cooldown enforced by `template_throttle` |

Template definition expected in the provider hub:

```
Category: UTILITY
Name:     smart_session_20260521
Language: en
Body:     You have unread message(s)
Buttons:  [Quick Reply: "Read Now"]
```

> **Note for production:** the dev WABA already has this template. Production rollout needs the same template approved on the prod WABA (the 360dialog channel pointed at by the local `.env`, not `.env.dev`).

### 7.7 Plugin — buffer module

Both plugins share the same logical interface; openclaw-plugin and claude-plugin each implement it for their respective workspace conventions.

```ts
type BufferedMessage = {
  id: string;            // local UUID
  wab: string;           // E.164
  phone: string;         // E.164
  kind: "text" | "media";
  text?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "audio" | "document";
  caption?: string;
  fileName?: string;
  enqueuedAt: string;    // ISO-8601
  attempts: number;
  lastError?: string;
};

interface Buffer {
  enqueue(m: BufferedMessage): Promise<void>;
  hasPending(wab: string, phone: string): Promise<boolean>;
  listPending(wab: string, phone: string): Promise<BufferedMessage[]>; // oldest first
  enumeratePending(): Promise<{ wab: string; phone: string }[]>;       // for startup flush
  markDelivered(id: string): Promise<void>;
  recordFailure(id: string, err: string): Promise<void>;
  sweepExpired(ttlMs: number): Promise<number>;
}
```

**File layout.** `<workspace>/wa-buffer/<wab_e164>/<phone_e164>.jsonl` — one JSON record per line. Append on enqueue; rewrite (under a `proper-lockfile` lock) on flush. Files `0600`, parent dir `0700`.

**Workspace roots:**

| Plugin | Default workspace root |
| :--- | :--- |
| `openclaw-plugin` | OpenClaw SDK-provided per-account workspace dir |
| `claude-plugin` | `$CLAUDE_PLUGIN_HOME` (defaults to `~/.claude-plugin-whatsapp/`) |

Both honour `WA_BUFFER_DIR` as an override.

### 7.8 Plugin — outbound interception (efficiency throttle)

```ts
async function sendOutbound(cfg, accountId, msg) {
  if (await buffer.hasPending(msg.wab, msg.to)) {
    const id = uuid();
    await buffer.enqueue({ id, ...msg, enqueuedAt: nowIso(), attempts: 0 });
    return { status: "queued", localId: id };
  }
  const res = await postSend(cfg, msg);
  if (res.status === "accepted") {
    return { status: "delivered", messageId: res.messageId };
  }
  if (res.status === "window_closed") {
    const id = uuid();
    await buffer.enqueue({ id, ...msg, enqueuedAt: nowIso(), attempts: 0 });
    return { status: "queued", localId: id, templateSent: res.templateSent };
  }
  throw new Error(`unexpected status ${res.status}`);
}
```

The `hasPending` pre-check is the **efficiency throttle**: as long as the buffer for `(wab, phone)` is non-empty, no `/api/v1/send` call is made — saving a round-trip and a doomed provider call. The authoritative **cost throttle** is the server-side `template_throttle` table from §7.3, which guards against duplicate template sends even if the plugin throttle is bypassed (buggy client, manual `curl`, future multi-instance topology).

### 7.9 Plugin — flush

```ts
async function flushBuffer(wab, phone) {
  const lock = await acquirePerPhoneLock(wab, phone);
  try {
    const pending = await buffer.listPending(wab, phone);
    for (const m of pending) {
      try {
        const res = await postSend(cfg, m);
        if (res.status === "accepted") {
          await buffer.markDelivered(m.id);
          continue;
        }
        // window_closed again — abort and try on the next inbound.
        break;
      } catch (e) {
        await buffer.recordFailure(m.id, String(e));
        if (m.attempts + 1 < WA_BUFFER_MAX_FLUSH_ATTEMPTS) break;
        // attempts exhausted → skip this entry, continue with the next
      }
    }
  } finally {
    lock.release();
  }
}

ws.on("INBOUND_MESSAGE", async (env) => {
  await flushBuffer(env.payload.wab, env.payload.from);
  await handleInbound(env);
});

ws.on("WINDOW_OPENED", (env) => flushBuffer(env.payload.wab, env.payload.phone));

// Startup: scan the buffer dir for every (wab, phone) with pending entries
// and try to flush each. If the window is open, messages go through. If
// it's closed, the first send returns window_closed — the server-side
// throttle (§7.3) suppresses a duplicate template if one was already sent
// before the restart, and the entries stay buffered for the next inbound.
async function flushAllOnStartup() {
  for (const { wab, phone } of await buffer.enumeratePending()) {
    flushBuffer(wab, phone).catch(() => {});  // best-effort, parallel-safe
  }
}
```

Ordering is guaranteed by `listPending` returning oldest-first; concurrency is bounded by the per-phone lock. On startup, the plugin proactively retries every buffered pair — no new backend endpoint needed; the existing `/api/v1/send` path handles both outcomes correctly because the server-side `template_throttle` row from before the restart prevents a duplicate billable template.

### 7.10 Plugin env vars

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `WA_BUFFER_DIR` | `<workspace>/wa-buffer` | Override buffer root |
| `WA_BUFFER_TTL_HOURS` | `72` | Max age of a pending entry before sweep |
| `WA_BUFFER_MAX_PER_PHONE` | `50` | Cap; overflow drops oldest pending |
| `WA_BUFFER_SWEEP_INTERVAL_MIN` | `15` | Sweeper period |
| `WA_BUFFER_MAX_FLUSH_ATTEMPTS` | `3` | Per-entry retry cap; exhausted entries are skipped, not retried |

---

## 8. Observability

### Backend

| Metric | Type | Labels |
| :--- | :--- | :--- |
| `wa_send_outcome_total` | counter | `outcome=accepted\|window_closed\|error` |
| `wa_reengagement_template_total` | counter | `outcome=ok\|err` |
| `wa_reengagement_template_throttled_total` | counter | — (skipped due to `template_throttle`) |
| `wa_window_opened_total` | counter | — (button-reply triggers) |

Log lines: `send.window_closed`, `template.sent`, `template.throttled`, `template.failed` (ERROR), `window.opened`. None include message bodies — bodies don't reach the backend in any storable form.

### Plugin

| Counter |
| :--- |
| `wa_plugin_buffer_enqueued_total{kind}` |
| `wa_plugin_buffer_flushed_total{kind,outcome}` |
| `wa_plugin_buffer_expired_total{reason=ttl\|overflow}` |
| `wa_plugin_buffer_depth_gauge` |

Log lines: `buffer.enqueued`, `buffer.flushed`, `buffer.expired` — local IDs and phone numbers only, no bodies.

---

## 9. Error Handling and Edge Cases

| Scenario | Behaviour |
| :--- | :--- |
| Send within window | `accepted` → delivered to user. |
| Send outside window, first of episode (no prior throttle row) | Backend gets `131047`, sends template best-effort, writes `template_throttle`, returns `window_closed` + `templateSent: true`. Plugin buffers. |
| Send outside window, second+ of episode (buffer non-empty) | Plugin's `hasPending` short-circuits and enqueues without API call. No backend involvement. |
| Send outside window, throttle row already within 24h | Backend skips the provider template call entirely; returns `window_closed` + `templateSent: false`. `wa_reengagement_template_throttled_total` increments. Plugin still buffers. |
| Concurrent `/api/v1/send` calls passing the throttle check together | Both reach `SendTemplate`; up to two billable sends in the race window (request RTT). `MarkTemplateSent` upserts; only the latest timestamp persists. Acceptable v1 risk; tighten with `SELECT ... FOR UPDATE` if operators see this in metrics. |
| Template send fails (provider 4xx, not approved, network) | `MarkTemplateSent` is **not** called, so the throttle is not consumed. `window_closed` returned with `templateSent: false`. ERROR log + alert. The next API-reaching send for this phone retries the template — but since the plugin's `hasPending` is true at that point, no retry happens automatically; operator must fix the template config out-of-band. |
| User replies normally | Standard `INBOUND_MESSAGE`. Plugin flushes buffer → agent dispatch. |
| User taps `Read Now` | Webhook → backend detects button payload → `WINDOW_OPENED` WS push (no `INBOUND_MESSAGE`). Plugin flushes. Agent never sees the synthetic payload. |
| Flush partial failure (one entry hits non-window error) | Failed entry records the error and increments `attempts`. If under cap: break loop (preserve order; retry next inbound). If at cap: skip and continue — operator can inspect the JSONL file. |
| Flush returns `window_closed` mid-loop | Window must have re-closed; very rare. Break loop; buffer remains for the next inbound. |
| Buffer cap reached | Oldest pending entry is dropped (`expired_total{reason=overflow}` increments). |
| Entry past TTL | Sweeper drops; `expired_total{reason=ttl}` increments. |
| Plugin restart | Entries on disk survive. On startup, `flushAllOnStartup` scans the buffer dir and calls `flushBuffer` for every `(wab, phone)` with pending entries. If the window is open, messages drain. If it's closed, the first send returns `window_closed`; the server-side throttle suppresses a duplicate template (one was already sent before the restart); entries remain on disk for the next inbound. |
| User unpairs (mapping → DISCONNECTED) with entries in buffer | Next flush attempt hits the existing `404 unpaired` response; plugin clears the buffer for that phone. |
| Sender unpaired (no `device_mappings` row) | Existing `404` path. No window check, no template, no buffer. |
| Phone sends the literal string `OPENCLAW_READ_NOW` as a text message (not via button) | Forwarded as a normal `INBOUND_MESSAGE`. The button-reply suppression only matches the structured button payload field, not free text. Agent sees the message. |

---

## 10. Security and Compliance

### 10.1 Authentication

Unchanged. `/api/v1/send` requires Bearer; webhook validates HMAC (Meta) or `Ocp-Apim-Subscription-Key` (360dialog); button-reply events authenticate identically.

### 10.2 Data minimisation — preserved

- The routing server stores **zero** agent-produced message content. The only new server-side row (`template_throttle`) holds `(wab, phone, template_name, last_sent_at)` — pure routing metadata for cost control.
- Buffered bodies live exclusively on the operator's local disk, under `0600` files in a `0700` directory.
- Server log lines and metrics contain phone numbers + template names only.

### 10.3 Template send cost

WhatsApp utility templates are billable. The cost-control architecture is layered:

1. **Server-side `template_throttle` (authoritative)** — at most one billable send per `(wab, phone, template)` per `TEMPLATE_THROTTLE_HOURS` (default 24h). Works regardless of plugin behaviour. Cannot be bypassed by a misbehaving or absent plugin throttle.
2. **Plugin-side `hasPending` (efficiency)** — while a phone has buffered messages, the plugin doesn't even attempt the API, saving round-trips and provider invocations.

Operators should monitor `wa_reengagement_template_total{outcome=ok}` (actual cost) and `wa_reengagement_template_throttled_total` (cost avoided) for anomalies. A future enhancement may add a global daily cap per WABA.

---

## 11. Acceptance Criteria

### Routing server

| # | Criterion |
| :--- | :--- |
| AC-S01 | `/api/v1/send` returns `{ status: "accepted", messageId }` when the provider call succeeds. |
| AC-S02 | `/api/v1/send` returns `{ status: "window_closed", templateSent: true }` when `Provider.SendText` returns `ErrWindowClosed`, no `template_throttle` row exists within the window, and `SendTemplate` succeeds. A row is written to `template_throttle`. |
| AC-S03 | `/api/v1/send` returns `{ status: "window_closed", templateSent: false }` when `SendText` returns `ErrWindowClosed` and a `template_throttle` row exists within `TEMPLATE_THROTTLE_HOURS`. `Provider.SendTemplate` is **not** called. `wa_reengagement_template_throttled_total` increments. |
| AC-S04 | `/api/v1/send` returns `{ status: "window_closed", templateSent: false }` when `SendText` returns `ErrWindowClosed` and `SendTemplate` fails (logged as ERROR). The `template_throttle` row is **not** updated. |
| AC-S05 | The only new persistent table on the backend is `template_throttle` with columns `(wab_number, phone_number, template_name, last_sent_at)`. No message-content columns anywhere. |
| AC-S06 | `template_throttle` survives a backend restart across `memory` (no), `sqlite`, `file` drivers. |
| AC-S07 | `SendTemplate` implementations exist for `meta`, `360dialog`, `stub`. The 360dialog implementation matches the verified-2026-06-01 payload shape. |
| AC-S08 | A button-reply webhook with payload `OPENCLAW_READ_NOW` pushes `WINDOW_OPENED` and is **not** forwarded as `INBOUND_MESSAGE`. |
| AC-S09 | All other inbound webhooks forward as `INBOUND_MESSAGE` exactly as before (no schema change to the existing envelope). |

### Plugin (each of openclaw-plugin and claude-plugin)

| # | Criterion |
| :--- | :--- |
| AC-P01 | When `buffer.hasPending(wab, phone)` is true, `sendOutbound` enqueues without calling `/api/v1/send`. |
| AC-P02 | A `200 window_closed` response causes `sendOutbound` to enqueue and return `{ status: "queued", localId }`. |
| AC-P03 | On `INBOUND_MESSAGE`, the plugin calls `flushBuffer` and only dispatches to the agent runtime after the flush returns. |
| AC-P04 | On `WINDOW_OPENED`, the plugin calls `flushBuffer` and does **not** dispatch to the agent. |
| AC-P05 | Flushed entries are sent oldest-first; an `accepted` response marks the entry delivered (removed from JSONL). |
| AC-P06 | Plugin restart preserves pending entries. |
| AC-P06a | On startup, the plugin calls `flushBuffer` for every `(wab, phone)` returned by `enumeratePending`. Open-window phones drain; closed-window phones receive at most zero new templates (server-side throttle blocks duplicates). |
| AC-P07 | Buffer cap drops the oldest pending entry on overflow. |
| AC-P08 | The sweeper drops entries past `WA_BUFFER_TTL_HOURS`. |
| AC-P09 | Buffer files have mode `0600`; the `wa-buffer` directory has mode `0700`. |
| AC-P10 | No plugin log line contains message body text or media URLs (`text`, `caption`, `mediaUrl` are referenced only by `localId` in logs). |

---

## 12. Open Questions

None outstanding for v1. All earlier candidates resolved into the spec or moved to §13.

---

## 13. Out of Scope / Future Work

- Server-side window state tracking (explicitly removed — only the throttle timestamp, not the inbound timestamp, is persisted).
- Outbound delivery receipts via Meta status webhooks.
- Marketing-category templates.
- Smart consolidation of multiple buffered messages into one.
- User opt-out of re-engagement templates.
- Shared-buffer storage for multi-instance deployments.
- **Template variables** (e.g. `{{1}}` for unread count). Static body in v1.
- **Global daily template cost cap per WABA.** Per-`(wab, phone)` throttle is the only cost guard in v1.
- **Per-instance template override.** Server-wide template name in v1; future enterprise customers may want their own approved templates.
- **Plugin startup polling endpoint** (`GET /api/v1/window/{phone}`). Replaced by §7.9's startup-flush — same outcome, no new backend surface.
