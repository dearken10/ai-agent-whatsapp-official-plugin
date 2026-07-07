package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

// sqliteStore is an SQLite-backed persistent store.
// It requires no external server — the database lives in a single .db file.
// WAL mode is enabled so concurrent reads never block writes.
type sqliteStore struct {
	db *sql.DB
}

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS pairing_records (
	id           TEXT PRIMARY KEY,
	instance_id  TEXT NOT NULL,
	api_key      TEXT NOT NULL,
	pairing_code TEXT,
	phone_number TEXT,
	wab_number   TEXT NOT NULL DEFAULT '',
	status       TEXT NOT NULL DEFAULT 'PENDING',
	pairing_mode TEXT NOT NULL DEFAULT 'single_use',
	invite_id    TEXT NOT NULL DEFAULT '',
	expires_at   INTEGER NOT NULL,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL,
	last_inbound_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pairing_records_phone  ON pairing_records(phone_number);
CREATE INDEX IF NOT EXISTS idx_pairing_records_code   ON pairing_records(pairing_code);
CREATE INDEX IF NOT EXISTS idx_pairing_records_apikey ON pairing_records(api_key);

CREATE TABLE IF NOT EXISTS persistent_invites (
	id          TEXT PRIMARY KEY,
	instance_id TEXT NOT NULL,
	api_key     TEXT NOT NULL UNIQUE,
	code        TEXT NOT NULL UNIQUE,
	wab_number  TEXT NOT NULL DEFAULT '',
	created_at  INTEGER NOT NULL,
	revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_persistent_invites_code   ON persistent_invites(code);
CREATE INDEX IF NOT EXISTS idx_persistent_invites_apikey ON persistent_invites(api_key);

CREATE TABLE IF NOT EXISTS pair_requests (
	client_ip    TEXT NOT NULL,
	requested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pair_requests_ip ON pair_requests(client_ip, requested_at);

CREATE TABLE IF NOT EXISTS template_throttle (
	wab_number    TEXT NOT NULL,
	phone_number  TEXT NOT NULL,
	template_name TEXT NOT NULL,
	last_sent_at  INTEGER NOT NULL,
	PRIMARY KEY (wab_number, phone_number, template_name)
);
`

// NewSQLite opens (or creates) an SQLite database at path and runs the schema.
func NewSQLite(path string) (*sqliteStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("sqlite store: mkdir: %w", err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("sqlite store: open: %w", err)
	}
	// WAL mode: concurrent reads don't block writes; single writer at a time.
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		return nil, fmt.Errorf("sqlite store: pragma: %w", err)
	}
	if _, err = db.Exec(sqliteSchema); err != nil {
		return nil, fmt.Errorf("sqlite store: schema: %w", err)
	}
	// Migration safety: add new columns to existing databases.
	if err = tryAddColumn(db, "pairing_records", "pairing_mode", "TEXT NOT NULL DEFAULT 'single_use'"); err != nil {
		return nil, fmt.Errorf("sqlite store: migrate pairing_mode: %w", err)
	}
	if err = tryAddColumn(db, "pairing_records", "invite_id", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return nil, fmt.Errorf("sqlite store: migrate invite_id: %w", err)
	}
	if err = tryAddColumn(db, "pairing_records", "last_inbound_at", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return nil, fmt.Errorf("sqlite store: migrate last_inbound_at: %w", err)
	}
	if err = migrateDropAPIKeyUnique(db); err != nil {
		return nil, fmt.Errorf("sqlite store: migrate drop api_key UNIQUE: %w", err)
	}
	return &sqliteStore{db: db}, nil
}

// migrateDropAPIKeyUnique rebuilds pairing_records without the legacy UNIQUE
// constraint on api_key. The constraint was valid when every pairing minted a
// fresh key, but persistent invites legitimately share one api_key across many
// pairings — the constraint blocks the second phone from pairing.
//
// SQLite can't drop a column constraint in place, so we copy into a new table
// and rename. Idempotent: returns early when the constraint is already gone.
var apiKeyUniqueRe = regexp.MustCompile(`(?i)api_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE`)

func migrateDropAPIKeyUnique(db *sql.DB) error {
	var schema string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name='pairing_records'`).Scan(&schema)
	if err != nil {
		return fmt.Errorf("read schema: %w", err)
	}
	if !apiKeyUniqueRe.MatchString(schema) {
		return nil
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err = tx.Exec(`
		CREATE TABLE pairing_records_new (
			id           TEXT PRIMARY KEY,
			instance_id  TEXT NOT NULL,
			api_key      TEXT NOT NULL,
			pairing_code TEXT,
			phone_number TEXT,
			wab_number   TEXT NOT NULL DEFAULT '',
			status       TEXT NOT NULL DEFAULT 'PENDING',
			pairing_mode TEXT NOT NULL DEFAULT 'single_use',
			invite_id    TEXT NOT NULL DEFAULT '',
			expires_at   INTEGER NOT NULL,
			created_at   INTEGER NOT NULL,
			updated_at   INTEGER NOT NULL,
			last_inbound_at INTEGER NOT NULL DEFAULT 0
		)`); err != nil {
		return fmt.Errorf("create new table: %w", err)
	}
	if _, err = tx.Exec(`
		INSERT INTO pairing_records_new
			(id, instance_id, api_key, pairing_code, phone_number, wab_number, status,
			 pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at)
		SELECT id, instance_id, api_key, pairing_code, phone_number, wab_number, status,
		       pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at
		FROM pairing_records`); err != nil {
		return fmt.Errorf("copy rows: %w", err)
	}
	if _, err = tx.Exec(`DROP TABLE pairing_records`); err != nil {
		return fmt.Errorf("drop old table: %w", err)
	}
	if _, err = tx.Exec(`ALTER TABLE pairing_records_new RENAME TO pairing_records`); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	// Recreate the indexes (DROP TABLE removed the old ones along with the auto-index).
	for _, stmt := range []string{
		`CREATE INDEX IF NOT EXISTS idx_pairing_records_phone  ON pairing_records(phone_number)`,
		`CREATE INDEX IF NOT EXISTS idx_pairing_records_code   ON pairing_records(pairing_code)`,
		`CREATE INDEX IF NOT EXISTS idx_pairing_records_apikey ON pairing_records(api_key)`,
	} {
		if _, err = tx.Exec(stmt); err != nil {
			return fmt.Errorf("recreate index: %w", err)
		}
	}
	return tx.Commit()
}

// tryAddColumn adds a column to a table if it does not already exist.
// SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN, so we
// detect the "duplicate column" error and ignore it.
func tryAddColumn(db *sql.DB, table, column, definition string) error {
	_, err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition))
	if err != nil {
		// SQLite error message for duplicate column contains "duplicate column name"
		if isDuplicateColumnError(err) {
			return nil
		}
		return err
	}
	return nil
}

func isDuplicateColumnError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	// modernc.org/sqlite returns: "duplicate column name: <col>"
	for i := range s {
		if len(s[i:]) >= 21 && s[i:i+21] == "duplicate column name" {
			return true
		}
	}
	return false
}

func (s *sqliteStore) CreatePending(r *PairingRecord) error {
	_, err := s.db.Exec(`
		INSERT INTO pairing_records
			(id, instance_id, api_key, pairing_code, phone_number, wab_number, status,
			 pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.InstanceID, r.APIKey, r.PairingCode, r.PhoneNumber, r.WabNumber,
		string(r.Status), string(r.PairingMode), r.InviteID,
		r.ExpiresAt.Unix(), r.CreatedAt.Unix(), r.UpdatedAt.Unix(), unixOrZero(r.LastInboundAt),
	)
	if err != nil {
		return fmt.Errorf("sqlite store: CreatePending: %w", err)
	}
	return nil
}

func (s *sqliteStore) FindByPhone(phone string) (*PairingRecord, bool, error) {
	row := s.db.QueryRow(`
		SELECT id, instance_id, api_key, pairing_code, phone_number, wab_number,
		       status, pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at
		FROM   pairing_records
		WHERE  phone_number = ? AND status = 'ACTIVE'
		ORDER  BY updated_at DESC
		LIMIT  1`, phone)
	r, err := scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("sqlite store: FindByPhone: %w", err)
	}
	return r, true, nil
}

func (s *sqliteStore) FindByAPIKey(apiKey string) (*PairingRecord, bool, error) {
	// Tie-break by status so that when two rows for the same api_key share
	// the latest updated_at (e.g. ActivatePersistentPairing wrote both the
	// supersede-DISCONNECTED and the new-ACTIVE rows in one transaction),
	// the ACTIVE row wins and gets cached. Without this, handleWS could
	// cache the DISCONNECTED row and silently drop subsequent webhooks.
	row := s.db.QueryRow(`
		SELECT id, instance_id, api_key, pairing_code, phone_number, wab_number,
		       status, pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at
		FROM   pairing_records
		WHERE  api_key = ?
		ORDER  BY updated_at DESC,
		          CASE status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END
		LIMIT  1`, apiKey)
	r, err := scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("sqlite store: FindByAPIKey: %w", err)
	}
	return r, true, nil
}

func (s *sqliteStore) ActivatePairing(code string, phone string, now time.Time) (*PairingRecord, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePairing: begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Fetch the pending record.
	row := tx.QueryRow(`
		SELECT id, instance_id, api_key, pairing_code, phone_number, wab_number,
		       status, pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at
		FROM   pairing_records
		WHERE  pairing_code = ?`, code)
	r, err := scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("pairing code not found")
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePairing: lookup: %w", err)
	}
	if r.ExpiresAt.Before(now) {
		return nil, errors.New("pairing code expired")
	}

	// Evict any existing active record for the same (wab_number, phone_number).
	_, err = tx.Exec(`
		UPDATE pairing_records
		SET    status = 'DISCONNECTED', updated_at = ?
		WHERE  wab_number = ? AND phone_number = ? AND status = 'ACTIVE' AND id != ?`,
		now.Unix(), r.WabNumber, phone, r.ID)
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePairing: evict: %w", err)
	}

	// Activate. The pairing-code message is itself a user-initiated inbound,
	// so it opens the 24h window — stamp last_inbound_at accordingly.
	_, err = tx.Exec(`
		UPDATE pairing_records
		SET    phone_number = ?, status = 'ACTIVE', pairing_code = NULL,
		       updated_at = ?, last_inbound_at = ?
		WHERE  id = ?`,
		phone, now.Unix(), now.Unix(), r.ID)
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePairing: activate: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePairing: commit: %w", err)
	}

	r.PhoneNumber = phone
	r.Status = StatusActive
	r.PairingCode = ""
	r.UpdatedAt = now
	r.LastInboundAt = now
	return r, nil
}

// --- Persistent invite methods ---

func (s *sqliteStore) CreateInvite(inv *PersistentInvite) error {
	_, err := s.db.Exec(`
		INSERT INTO persistent_invites (id, instance_id, api_key, code, wab_number, created_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		inv.ID, inv.InstanceID, inv.APIKey, inv.Code, inv.WabNumber,
		inv.CreatedAt.Unix(), nullUnixTime(inv.RevokedAt),
	)
	if err != nil {
		return fmt.Errorf("sqlite store: CreateInvite: %w", err)
	}
	return nil
}

func (s *sqliteStore) FindInviteByCode(code string) (*PersistentInvite, bool, error) {
	row := s.db.QueryRow(`
		SELECT id, instance_id, api_key, code, wab_number, created_at, revoked_at
		FROM   persistent_invites
		WHERE  code = ? AND revoked_at IS NULL
		LIMIT  1`, code)
	inv, err := scanInvite(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("sqlite store: FindInviteByCode: %w", err)
	}
	return inv, true, nil
}

func (s *sqliteStore) FindInviteByID(id string) (*PersistentInvite, bool, error) {
	row := s.db.QueryRow(`
		SELECT id, instance_id, api_key, code, wab_number, created_at, revoked_at
		FROM   persistent_invites
		WHERE  id = ?
		LIMIT  1`, id)
	inv, err := scanInvite(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("sqlite store: FindInviteByID: %w", err)
	}
	return inv, true, nil
}

func (s *sqliteStore) FindInviteByAPIKey(apiKey string) (*PersistentInvite, bool, error) {
	row := s.db.QueryRow(`
		SELECT id, instance_id, api_key, code, wab_number, created_at, revoked_at
		FROM   persistent_invites
		WHERE  api_key = ? AND revoked_at IS NULL
		LIMIT  1`, apiKey)
	inv, err := scanInvite(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("sqlite store: FindInviteByAPIKey: %w", err)
	}
	return inv, true, nil
}

func (s *sqliteStore) RevokeInvite(id string, now time.Time) error {
	res, err := s.db.Exec(`
		UPDATE persistent_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		now.Unix(), id)
	if err != nil {
		return fmt.Errorf("sqlite store: RevokeInvite: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("invite not found or already revoked")
	}
	return nil
}

func (s *sqliteStore) ActivatePersistentPairing(invite *PersistentInvite, phone string, now time.Time) (*PairingRecord, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePersistentPairing: begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Disconnect any existing active record for this phone on the same WAB number.
	_, err = tx.Exec(`
		UPDATE pairing_records
		SET    status = 'DISCONNECTED', updated_at = ?
		WHERE  wab_number = ? AND phone_number = ? AND status = 'ACTIVE'`,
		now.Unix(), invite.WabNumber, phone)
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePersistentPairing: evict: %w", err)
	}

	record := &PairingRecord{
		ID:          uuid.NewString(),
		InstanceID:  invite.InstanceID,
		APIKey:      invite.APIKey,
		PhoneNumber: phone,
		WabNumber:   invite.WabNumber,
		Status:      StatusActive,
		PairingMode:   ModePersistent,
		InviteID:      invite.ID,
		ExpiresAt:     time.Time{}, // no expiry for persistent pairings
		CreatedAt:     now,
		UpdatedAt:     now,
		LastInboundAt: now, // the invite-code message opens the 24h window
	}

	_, err = tx.Exec(`
		INSERT INTO pairing_records
			(id, instance_id, api_key, pairing_code, phone_number, wab_number, status,
			 pairing_mode, invite_id, expires_at, created_at, updated_at, last_inbound_at)
		VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		record.ID, record.InstanceID, record.APIKey, record.PhoneNumber, record.WabNumber,
		string(record.Status), string(record.PairingMode), record.InviteID,
		record.CreatedAt.Unix(), record.UpdatedAt.Unix(), record.LastInboundAt.Unix(),
	)
	if err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePersistentPairing: insert: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("sqlite store: ActivatePersistentPairing: commit: %w", err)
	}
	return record, nil
}

func (s *sqliteStore) UpdateLastInboundAt(phone string, ts time.Time) error {
	// Refresh every ACTIVE row for this phone. In persistent-mode pairings a
	// phone can hold ACTIVE rows across multiple WABs; any of them is a valid
	// route target, so all need the fresh timestamp.
	_, err := s.db.Exec(
		`UPDATE pairing_records SET last_inbound_at = ? WHERE phone_number = ? AND status = 'ACTIVE'`,
		unixOrZero(ts), phone,
	)
	if err != nil {
		return fmt.Errorf("sqlite store: UpdateLastInboundAt: %w", err)
	}
	return nil
}

func (s *sqliteStore) TrackPairRequest(clientIP string, now time.Time, limit int) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, fmt.Errorf("sqlite store: TrackPairRequest: begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	oneHourAgo := now.Add(-time.Hour).Unix()

	// Purge stale entries.
	if _, err = tx.Exec(`DELETE FROM pair_requests WHERE client_ip = ? AND requested_at < ?`,
		clientIP, oneHourAgo); err != nil {
		return false, fmt.Errorf("sqlite store: TrackPairRequest: purge: %w", err)
	}

	// Count recent requests.
	var count int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM pair_requests WHERE client_ip = ?`, clientIP).
		Scan(&count); err != nil {
		return false, fmt.Errorf("sqlite store: TrackPairRequest: count: %w", err)
	}
	if count >= limit {
		_ = tx.Commit()
		return false, nil
	}

	if _, err = tx.Exec(`INSERT INTO pair_requests (client_ip, requested_at) VALUES (?, ?)`,
		clientIP, now.Unix()); err != nil {
		return false, fmt.Errorf("sqlite store: TrackPairRequest: insert: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("sqlite store: TrackPairRequest: commit: %w", err)
	}
	return true, nil
}

func (s *sqliteStore) WasTemplateSentRecently(wab, phone, template string, within time.Duration, now time.Time) (bool, error) {
	row := s.db.QueryRow(`
		SELECT last_sent_at FROM template_throttle
		WHERE  wab_number = ? AND phone_number = ? AND template_name = ?`,
		wab, phone, template)
	var lastSent int64
	if err := row.Scan(&lastSent); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("sqlite store: WasTemplateSentRecently: %w", err)
	}
	return now.Sub(time.Unix(lastSent, 0)) < within, nil
}

func (s *sqliteStore) MarkTemplateSent(wab, phone, template string, now time.Time) error {
	_, err := s.db.Exec(`
		INSERT INTO template_throttle (wab_number, phone_number, template_name, last_sent_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(wab_number, phone_number, template_name)
		DO UPDATE SET last_sent_at = excluded.last_sent_at`,
		wab, phone, template, now.Unix())
	if err != nil {
		return fmt.Errorf("sqlite store: MarkTemplateSent: %w", err)
	}
	return nil
}

func (s *sqliteStore) Close() error {
	return s.db.Close()
}

// scanRecord reads one row from a QueryRow result.
func scanRecord(row *sql.Row) (*PairingRecord, error) {
	var r PairingRecord
	var status, pairingMode string
	var expiresAt, createdAt, updatedAt, lastInboundAt int64
	var pairingCode, phoneNumber, inviteID sql.NullString
	err := row.Scan(
		&r.ID, &r.InstanceID, &r.APIKey, &pairingCode, &phoneNumber, &r.WabNumber,
		&status, &pairingMode, &inviteID,
		&expiresAt, &createdAt, &updatedAt, &lastInboundAt,
	)
	if err != nil {
		return nil, err
	}
	r.PairingCode = pairingCode.String
	r.PhoneNumber = phoneNumber.String
	r.InviteID = inviteID.String
	r.Status = Status(status)
	r.PairingMode = PairingMode(pairingMode)
	r.ExpiresAt = time.Unix(expiresAt, 0).UTC()
	r.CreatedAt = time.Unix(createdAt, 0).UTC()
	r.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	r.LastInboundAt = timeFromUnixOrZero(lastInboundAt)
	return &r, nil
}

// scanInvite reads one row from a persistent_invites QueryRow result.
func scanInvite(row *sql.Row) (*PersistentInvite, error) {
	var inv PersistentInvite
	var createdAt int64
	var revokedAt sql.NullInt64
	err := row.Scan(
		&inv.ID, &inv.InstanceID, &inv.APIKey, &inv.Code, &inv.WabNumber,
		&createdAt, &revokedAt,
	)
	if err != nil {
		return nil, err
	}
	inv.CreatedAt = time.Unix(createdAt, 0).UTC()
	if revokedAt.Valid {
		t := time.Unix(revokedAt.Int64, 0).UTC()
		inv.RevokedAt = &t
	}
	return &inv, nil
}

// nullUnixTime returns nil for a nil time pointer, or the Unix timestamp as int64.
func nullUnixTime(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.Unix()
}

// unixOrZero returns 0 for a zero-valued time.Time (whose Unix() otherwise
// returns a large negative sentinel), or t.Unix() for any real timestamp.
// Callers pass this into the store where 0 is the canonical "never observed"
// value for last_inbound_at.
func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

// timeFromUnixOrZero is the inverse of unixOrZero: 0 → zero Time, any other
// Unix seconds → UTC time.Time.
func timeFromUnixOrZero(secs int64) time.Time {
	if secs == 0 {
		return time.Time{}
	}
	return time.Unix(secs, 0).UTC()
}
