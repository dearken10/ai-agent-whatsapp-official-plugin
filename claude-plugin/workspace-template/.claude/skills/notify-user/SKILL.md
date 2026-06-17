# Skill: Push a WhatsApp Notification

Send a WhatsApp message to the user paired with this Claude Code session.
Use whenever you need to deliver something outside the normal "reply to
the current turn" flow — async results, reminders, cron output, long-task
updates, unsolicited FYIs.

## Pre-set env vars

The bridge that started this session already exported:

- `ROUTING_BASE_URL` — routing backend base URL
- `ROUTING_API_KEY` — Bearer token (this paired user only)
- `USER_PHONE` — recipient (E.164). The backend rejects any other number.

## Send a text message

The workspace ships a `./send-wa` shim that handles all the protocol nuance
for you — HTTP code, JSON body inspection, and (critically) buffering the
message to disk when WhatsApp's 24-hour customer-service window is closed
so it auto-flushes when the user replies.

```bash
./send-wa "<your message>"
```

### Exit codes

| Code | Meaning                                                                                  |
|------|------------------------------------------------------------------------------------------|
| 0    | Delivered. `messageId=…` printed to stdout.                                              |
| 2    | NOT delivered now — 24h window closed. Message is queued in the plugin's local buffer and will flush automatically on the user's next inbound. |
| 1    | Hard failure (missing env, network, unexpected backend response).                        |

### Cron / async usage

```bash
if ! ./send-wa "daily summary: $(generate_summary)"; then
  rc=$?
  case "$rc" in
    2) logger "send-wa queued (window_closed)" ;;
    *) logger "send-wa failed rc=$rc" ;;
  esac
fi
```

### Raw HTTP (only if you can't use the shim)

```bash
http=$(curl -sS -o /tmp/wa_resp.json -w "%{http_code}" \
  -X POST "$ROUTING_BASE_URL/api/v1/send" \
  -H "Authorization: Bearer $ROUTING_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg to "$USER_PHONE" --arg text "<your message>" \
        '{toPhoneNumber: $to, text: $text}')")
# 200 + .status=accepted → delivered
# 200 + .status=window_closed → NOT delivered; raw curl cannot buffer.
# anything else → failure
```

Raw HTTP **cannot** populate the plugin buffer — `window_closed` messages
will be lost. Prefer `./send-wa`.

## When to use

- The user asks for a reminder ("ping me at 8am about X").
- You set up a cron / systemd timer / one-shot job and want it to deliver
  its result to WhatsApp.
- A long-running operation completes and you want to notify the user out
  of band.
- You want to send an unsolicited update.

## Limits

- Chunk messages over 3500 chars on newline boundaries.
- Send rate limits apply per WhatsApp account; keep notifications
  reasonable.

## What this skill is NOT

- Not a way to schedule remote (Anthropic-hosted) routines — those run
  in a different cloud and cannot reach `$ROUTING_BASE_URL`.
- Not a way to message arbitrary phone numbers — only `$USER_PHONE`.
