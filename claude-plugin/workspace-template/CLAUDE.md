# WhatsApp-paired Claude Code session

This Claude Code session is connected to a WhatsApp number through the imBee
routing bridge in `ai-agent-whatsapp-official-plugin`. Whatever the user types on
WhatsApp arrives here as your prompt; whatever text you produce goes back
to them as a WhatsApp message.

## Who you're talking to

- **User phone (E.164)**: `{{USER_PHONE}}`
- This is the only WhatsApp number the routing backend will let you send to.

## Pushing WhatsApp messages yourself

Beyond your normal reply, you can push a WhatsApp message to this user at
any time — useful for async results, reminders, cron output, status updates
from long-running tasks, or anything triggered outside the current turn.

The bridge pre-exports three environment variables:

- `ROUTING_BASE_URL` — routing backend base URL
- `ROUTING_API_KEY` — Bearer token (already authenticated for this user)
- `USER_PHONE` — same as the phone number above

### Send a text message

Use the `./send-wa` shim in this workspace. It handles the
`status: "window_closed"` case correctly and, when the 24-hour customer-service
window has closed, persists the message to the plugin's local buffer so it
flushes automatically the next time the user replies on WhatsApp.

```bash
./send-wa "your message here"
```

Exit codes:

| Code | Meaning                                                                     |
|------|-----------------------------------------------------------------------------|
| 0    | Delivered. `messageId=…` printed to stdout.                                 |
| 2    | NOT delivered now — 24h window closed; queued in plugin buffer, flushes on next inbound. |
| 1    | Hard failure (bad env, network, unexpected backend response).               |

Cron jobs and async scripts MUST use `./send-wa` (or the same JSON-aware
logic). A bare `curl` that only checks HTTP code silently treats
`window_closed` responses as success and loses messages.

### Rules

- The backend enforces `toPhoneNumber == USER_PHONE`. You cannot message
  arbitrary numbers from here — only the paired user.
- WhatsApp caps text at 4096 chars. Chunk longer messages on newline
  boundaries.
- The session ID for this conversation is managed by the bridge; you don't
  need to track it.

## Inbox

Any media the user attaches in WhatsApp (images, PDFs, voice notes) is
downloaded by the bridge into `./inbox/<timestamp>.<ext>` before your turn
starts, and your prompt mentions the file path. Use the Read tool to look
at images, PDFs, etc.

## Scheduling recurring tasks

If the user asks for a recurring notification ("every morning at 8am send me
the weather"), the right pattern is a local cron entry on **this** machine
that runs `claude -p "..."` and the resulting text is then piped through
the curl command above.

**Do not** suggest Anthropic-hosted scheduled routines (claude.ai/code/routines)
for this — those run in a different cloud and do not have these env vars
or access to the routing backend. They'd need an MCP connector for delivery,
which isn't set up here.

## What you don't get

- Bidirectional state across separate cron jobs (each is its own process).
- Anything that requires the bridge process to be reachable from outside —
  only `$ROUTING_BASE_URL` is exposed.
