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

Then select **Official WhatsApp API (imBee)** from the channel list and follow the pairing wizard.

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

**What WhatsApp message types are supported?**
Text, images, video, audio, voice notes, stickers, and documents. Images are passed to your agent as base64 data URIs so vision-capable models can read them directly. All other media types are described in text (filename, type, size).

**The agent received my message but didn't reply. Is something broken?**
Not necessarily. OpenClaw agents are configured to stay silent when a message doesn't warrant a response (e.g. a bare "hello" with no question or task). Try sending a specific question or request. If you believe it is broken, check your gateway logs with `openclaw logs`.

**Is this free forever?**
The free tier has no time limit or credit card requirement. It uses a shared imBee number with no SLA guarantees. For dedicated numbers, SLA, and enterprise support, see the Paid Plan above.

**I need my own branded WhatsApp number. How do I upgrade?**
Message imBee directly on WhatsApp: [wa.me/85230013636](https://wa.me/85230013636?text=I+need+a+dedicated+whatsapp+number+for+ai+agent). The Paid Plan includes a dedicated Official WhatsApp Business number with your custom display name and business profile.

**Is this plugin open source?**
The source is available at [github.com/dearken10/openclaw-whatsapp-plugin](https://github.com/dearken10/openclaw-whatsapp-plugin) under a source-available licence. Free for personal, non-commercial, and development use. Production deployments must route through imBee's hosted service. For self-hosted or white-label commercial use, contact info@imbee.io.

---

## Links

- [imBee](https://imbee.io) — operator of the shared WhatsApp Business Account
- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Report an issue](https://github.com/dearken10/openclaw-whatsapp-plugin/issues)
