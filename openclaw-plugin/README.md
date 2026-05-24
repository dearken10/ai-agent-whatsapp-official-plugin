# Official WhatsApp API for OpenClaw — by imBee

Connect your OpenClaw AI agent to WhatsApp in under 2 minutes — using the **official WhatsApp Business API**, with no Meta verification, no server setup, and no reverse-engineered libraries.

---

## Why This Exists

There are three hard problems with WhatsApp for local AI agents today:

| Problem | Reality |
| :--- | :--- |
| **Unofficial APIs are a liability** | Libraries like Baileys reverse-engineer the WhatsApp Web protocol. They break without warning and can get your number permanently banned. |
| **Official onboarding is an ordeal** | Getting your own WhatsApp Business number requires a verified Meta Business Manager, WABA approval, and weeks of back-and-forth with Meta. |
| **No bridge for local agents** | Even if you have API access, connecting a locally-running AI agent to a live webhook infrastructure is non-trivial to build and maintain. |

**imBee solves all three.** imBee operates a verified WhatsApp Business Account so you don't have to. This plugin connects your local OpenClaw agent to it in minutes via a one-time QR pairing code.

---

## How It Works

```
┌─────────────┐   WebSocket (WSS)   ┌──────────────────┐   Webhook   ┌──────────┐
│  Your local │ ◄───────────────── │  imBee Routing   │ ◄───────── │  Meta /  │
│  OpenClaw   │                    │  Server (HTTPS)  │            │ 360dialog│
│  agent      │ ──────────────────►│                  │ ──────────►│          │
└─────────────┘   /api/v1/send     └──────────────────┘            └──────────┘
```

1. **Pair** — Run `openclaw channels add`. A QR code appears. Scan it with your phone or tap the `wa.me` link. Send the pre-filled message. Done.
2. **Receive** — A WhatsApp message arrives at the shared number. imBee looks up your phone → instance mapping and forwards it to your agent over a persistent, encrypted WebSocket.
3. **Reply** — Your agent generates a response. The plugin sends it to imBee, which delivers it via the Meta Cloud API.

Setup time: **under 2 minutes**. Forwarding latency: **under 500ms**.

---

## Privacy & Data Governance

imBee is a **transparent proxy** — it routes messages in real time and stores nothing about their content.

| What imBee does NOT store | Why it matters |
| :--- | :--- |
| Message text or content | Your conversations are never logged on imBee's servers |
| Files, images, or documents | Media is forwarded in-memory and immediately discarded |
| Voice notes or audio | Audio passes through without being written to disk |
| Chat history or transcripts | No conversation history exists on imBee infrastructure |

Only routing metadata is persisted: your phone number, instance ID, and pairing status. All traffic uses TLS (HTTPS/WSS). Incoming webhooks are verified with HMAC-SHA256.

> *"imBee sees the envelope, not the letter. Your AI agent conversations remain between you and your users."*

---

## Plans

### Free Tier — Personal & Pilots

- **Shared** WhatsApp Business number operated by imBee
- Full OpenClaw AI agent integration via QR pairing
- Real-time message forwarding (text + media)
- No credit card required

**Best for:** individual developers, teachers, personal projects, and pilot programmes.

### Paid Plan — Enterprise & Branded Deployments

- **Dedicated** Official WhatsApp Business number — your own brand identity
- Custom display name and business profile
- Priority message throughput and full media support
- Phone number allowlist for approved senders

**Best for:** schools, universities, enterprises, or any organisation that needs a branded WhatsApp presence and cannot share a number with other tenants.

→ [Message imBee on WhatsApp](https://wa.me/85230013636?text=I+need+a+dedicated+whatsapp+number+for+ai+agent) to start a free pilot or request a dedicated number.

---

## Installation

```bash
openclaw plugins install openclaw-channel-whatsapp-official
openclaw channels add
```

Then select **WhatsApp Official API by imBee** from the channel list and follow the pairing wizard.

---

## Controlling who can reach your agent

After pairing, the plugin exposes two config fields that control which WhatsApp senders your agent will respond to.

### `dmPolicy`

| Value | Behaviour |
| :--- | :--- |
| `open` *(default)* | Any paired phone number can message your agent |
| `allowlist` | Only numbers explicitly listed in `allowFrom` can message your agent |
| `disabled` | All inbound DMs are silently ignored (outbound-only mode) |

### `allowFrom`

A list of E.164 phone numbers that are permitted to reach your agent. Only used when `dmPolicy` is `allowlist`.

### `dmDenyMessage`

The reply sent to a sender who is blocked by `dmPolicy: allowlist`. If omitted, the plugin sends a built-in default:

> *"You are not authorised to use this service. Please contact the service owner for access."*

Set this to include your own contact details so blocked users know who to reach out to.

### Example config

```yaml
channels:
  whatsapp-official:
    routingBaseUrl: "https://openclaw-plugin.dev.ent.imbee.io"
    instanceId: "your-instance-id"
    apiKey: "imbee_…"
    dmPolicy: allowlist
    allowFrom:
      - "+85296663768"
      - "+85261234567"
    dmDenyMessage: "Sorry, this assistant is for staff only. Contact hr@company.com to request access."
```

With this config, the two listed numbers can message your agent normally. Any other sender receives the `dmDenyMessage` reply and the message never reaches your agent.

### ⚠️ Persistent Invite and the open-door risk

When you use a **Persistent Invite** code, the same `wa.me` link can pair any number of contacts to your agent. This is intentional — it is designed for sharing. But it means:

> **Anyone who receives or guesses the link can pair and start sending messages to your agent.**

If you share a Persistent Invite publicly (e.g. in a QR code on a poster or a website), set `dmPolicy: allowlist` and keep `allowFrom` up to date, or use `dmPolicy: disabled` to pause the agent while you are not monitoring it.

For a **Single-Use** code the risk is lower because each code pairs exactly one number and expires in 10 minutes, but `allowlist` is still the right choice for any production or business deployment where you know exactly who should have access.

> **Tip:** you can change `dmPolicy` at any time without re-pairing — edit your OpenClaw config file and restart the gateway.

---

## Requirements

- OpenClaw ≥ 2026.4.15
- Node ≥ 22

---

## FAQ

**Can other users on the shared number see my messages?**
No. Every user is identified by their phone number. imBee routes each inbound message exclusively to the OpenClaw instance that paired with that specific number. Other tenants on the shared number never see your messages.

**Who operates the routing server? Can imBee read my conversations?**
imBee operates the routing server at `openclaw-plugin.dev.ent.imbee.io`. The server is a transparent proxy — message payloads are forwarded in memory and never written to disk or any database. Only routing metadata (your phone number, instance ID, and pairing status) is persisted. imBee sees the envelope, not the letter.

**What happens if I close my laptop or lose internet?**
The WebSocket connection drops and inbound messages are not queued — they will be missed while your agent is offline. For always-on availability, run your OpenClaw gateway on a server or use the Paid Plan which includes managed infrastructure options.

**My pairing code expired before I sent it. What do I do?**
Run `openclaw channels add` again to generate a fresh code. Codes expire after 10 minutes for security. There is no limit on how many times you can re-pair.

**I reinstalled OpenClaw and lost my API key. Can I recover it?**
No — API keys are issued once and not stored by imBee. Run `openclaw channels add` to re-pair. The new pairing will automatically deactivate the old one.

**Can someone else pair my phone number to their agent?**
Only if they obtain a valid pairing code and trick you into sending it via WhatsApp. Codes are short-lived (10 minutes), single-use, and sent to a specific `wa.me` URL — treat them like one-time passwords. If you suspect a code was misused, re-pair immediately to invalidate the old session.

**I shared a Persistent Invite link publicly and now strangers are messaging my agent. How do I stop this?**
Two options. Quick fix: add `dmPolicy: allowlist` and list only the numbers you want in `allowFrom` in your OpenClaw config, then restart the gateway — unapproved senders are immediately silenced. Nuclear option: revoke the invite with `openclaw channels manage`, which disconnects all phones paired via that code, then generate a fresh invite and share it more carefully.

**Can I allow some users but not others without re-pairing everyone?**
Yes. Set `dmPolicy: allowlist` and maintain the `allowFrom` list in your config. Adding or removing a number takes effect after a gateway restart — no re-pairing needed. Blocked senders automatically receive your `dmDenyMessage` so they know who to contact for access.

**What WhatsApp message types are supported?**
Text, images, video, audio, voice notes, stickers, and documents. Images are passed to your agent as base64 data URIs so vision-capable models can read them directly. All other media types are described in text (filename, type, size).

**The agent received my message but didn't reply. Is something broken?**
Not necessarily. OpenClaw agents are configured to stay silent when a message doesn't warrant a response (e.g. a bare "hello" with no question or task). Try sending a specific question or request. If you believe it is broken, check your gateway logs with `openclaw logs`.

**Is this free forever?**
The free tier has no time limit or credit card requirement. It uses a shared imBee number with no SLA guarantees. For dedicated numbers, SLA, and enterprise support, see the Paid Plan above.

**I need my own branded WhatsApp number. How do I upgrade?**
Message imBee directly on WhatsApp: [wa.me/85230013636](https://wa.me/85230013636?text=I+need+a+dedicated+whatsapp+number+for+ai+agent). The Paid Plan includes a dedicated Official WhatsApp Business number with your custom display name and business profile.

**Is this plugin open source?**
The source is available at [github.com/dearken10/ai-agent-whatsapp-official-plugin](https://github.com/dearken10/ai-agent-whatsapp-official-plugin) under a source-available licence. Free for personal, non-commercial, and development use. Production deployments must route through imBee's hosted service. For self-hosted or white-label commercial use, contact info@imbee.io.

---

## Links

- [imBee](https://imbee.io) — operator of the shared WhatsApp Business Account
- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Report an issue](https://github.com/dearken10/ai-agent-whatsapp-official-plugin/issues)
