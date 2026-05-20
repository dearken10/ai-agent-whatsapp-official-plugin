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

```bash
curl -sX POST "$ROUTING_BASE_URL/api/v1/send" \
  -H "Authorization: Bearer $ROUTING_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg to "$USER_PHONE" --arg text "<your message>" \
        '{toPhoneNumber: $to, text: $text}')"
```

200 = accepted. Response body has `messageId`.

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
