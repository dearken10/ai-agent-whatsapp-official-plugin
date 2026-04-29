---
name: query-wa-sqlite
description: Query the production WhatsApp routing server's SQLite database on AWS EC2
---

## Query the Production WA SQLite DB

The production routing server stores pairing records in a SQLite file on AWS EC2.

**Connection details:**
- SSH key: `~/.ssh/openclaw-wa.pem`
- User/host: `ec2-user@54.81.159.176` (resolves from `openclaw-plugin.dev.ent.imbee.io`)
- DB path on server: `/home/ec2-user/data/store.db` (+ `-shm` and `-wal` WAL files)
- `sqlite3` is NOT installed on the EC2 instance — must copy files locally to query

### Step 1 — Copy DB files locally

```bash
scp -i ~/.ssh/openclaw-wa.pem -o StrictHostKeyChecking=no \
  ec2-user@54.81.159.176:/home/ec2-user/data/store.db /tmp/prod-store.db
scp -i ~/.ssh/openclaw-wa.pem -o StrictHostKeyChecking=no \
  ec2-user@54.81.159.176:/home/ec2-user/data/store.db-shm /tmp/prod-store.db-shm
scp -i ~/.ssh/openclaw-wa.pem -o StrictHostKeyChecking=no \
  ec2-user@54.81.159.176:/home/ec2-user/data/store.db-wal /tmp/prod-store.db-wal
```

> All three files are needed for a consistent WAL-mode read.

### Step 2 — List tables

```bash
sqlite3 /tmp/prod-store.db ".tables"
# → pair_requests    pairing_records
```

### Schema

**`pairing_records`**
```sql
CREATE TABLE pairing_records (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL,
  api_key      TEXT NOT NULL UNIQUE,
  pairing_code TEXT,
  phone_number TEXT,        -- WA user's phone (E.164 without +)
  wab_number   TEXT NOT NULL DEFAULT '',  -- shared WA Business number
  status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | ACTIVE | DISCONNECTED
  expires_at   INTEGER NOT NULL,  -- unix epoch (pairing code TTL, ~10min after created_at)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

**`pair_requests`**
```sql
-- ip | unix_timestamp  (rate-limiting log)
```

### Useful queries

**All records, human-readable:**
```bash
sqlite3 -column -header /tmp/prod-store.db "
SELECT
  instance_id,
  api_key,
  pairing_code,
  phone_number as wa_phone,
  wab_number,
  status,
  datetime(expires_at, 'unixepoch') as expires_at,
  datetime(created_at, 'unixepoch') as created_at,
  datetime(updated_at, 'unixepoch') as updated_at
FROM pairing_records
ORDER BY created_at DESC;
"
```

**Active pairings only:**
```bash
sqlite3 -column -header /tmp/prod-store.db "
SELECT instance_id, phone_number, wab_number, datetime(updated_at,'unixepoch') as paired_at
FROM pairing_records WHERE status='ACTIVE' ORDER BY updated_at DESC;
"
```

**Pair request log (rate-limit history):**
```bash
sqlite3 -column -header /tmp/prod-store.db "
SELECT ip, datetime(requested_at,'unixepoch') as requested_at FROM pair_requests ORDER BY requested_at DESC;
"
```

### Notes

- `expires_at` reflects only the pairing code TTL — once paired, the record persists indefinitely.
- When a phone re-pairs to a new instance, the old instance's record is set to DISCONNECTED.
- The file is named `store.db` on the server (despite `STORE_FILE_PATH=/home/ec2-user/data/store.json` in `.env` — the Go driver appends `.db`).
