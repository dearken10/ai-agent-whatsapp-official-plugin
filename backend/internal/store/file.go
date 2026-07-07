package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// fileStore is a JSON-backed persistent store. All records are kept in memory
// and flushed to disk atomically (write to a temp file then rename) on every
// mutation. This is safe for single-process deployments and survives restarts.
//
// The on-disk format is a single JSON file:
//
//	{
//	  "records":      [ ...PairingRecord... ],
//	  "invites":      [ ...PersistentInvite... ],
//	  "pairRequests": { "ip": ["2026-04-23T10:00:00Z", ...] }
//	}
type fileStore struct {
	mu       sync.RWMutex
	path     string
	records  []*PairingRecord
	invites  []*PersistentInvite
	pairReqs map[string][]time.Time

	// templateThrottle: map[templateThrottleKey(wab, phone, template)] = last_sent_at
	templateThrottle map[string]time.Time

	// secondary indexes rebuilt on load / mutated in-place
	byCode          map[string]*PairingRecord
	byPhone         map[string]*PairingRecord
	byAPIKey        map[string]*PairingRecord
	byInviteID      map[string]*PersistentInvite
	byInviteCode    map[string]*PersistentInvite
	byInviteAPIKey  map[string]*PersistentInvite
}

// fileData is the on-disk JSON shape.
type fileData struct {
	Records          []*PairingRecord       `json:"records"`
	Invites          []*PersistentInvite    `json:"invites,omitempty"`
	PairRequests     map[string][]time.Time `json:"pairRequests"`
	TemplateThrottle map[string]time.Time   `json:"templateThrottle,omitempty"`
}

// NewFile opens (or creates) a JSON store at path.
func NewFile(path string) (*fileStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("file store: mkdir %s: %w", filepath.Dir(path), err)
	}

	fs := &fileStore{
		path:             path,
		byCode:           map[string]*PairingRecord{},
		byPhone:          map[string]*PairingRecord{},
		byAPIKey:         map[string]*PairingRecord{},
		byInviteID:       map[string]*PersistentInvite{},
		byInviteCode:     map[string]*PersistentInvite{},
		byInviteAPIKey:   map[string]*PersistentInvite{},
		pairReqs:         map[string][]time.Time{},
		templateThrottle: map[string]time.Time{},
	}

	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("file store: read %s: %w", path, err)
	}
	if len(data) > 0 {
		var fd fileData
		if err = json.Unmarshal(data, &fd); err != nil {
			return nil, fmt.Errorf("file store: parse %s: %w", path, err)
		}
		fs.records = fd.Records
		fs.invites = fd.Invites
		if fd.PairRequests != nil {
			fs.pairReqs = fd.PairRequests
		}
		if fd.TemplateThrottle != nil {
			fs.templateThrottle = fd.TemplateThrottle
		}
		fs.rebuildIndexes()
	}
	return fs, nil
}

// rebuildIndexes populates the in-memory lookup maps from fs.records and fs.invites.
// Must be called with the write lock held (or before the store is shared).
func (fs *fileStore) rebuildIndexes() {
	fs.byCode = map[string]*PairingRecord{}
	fs.byPhone = map[string]*PairingRecord{}
	fs.byAPIKey = map[string]*PairingRecord{}
	for _, r := range fs.records {
		if r.PairingCode != "" {
			fs.byCode[r.PairingCode] = r
		}
		if r.PhoneNumber != "" {
			// keep only the most recently updated active record per phone
			existing, ok := fs.byPhone[r.PhoneNumber]
			if !ok || r.UpdatedAt.After(existing.UpdatedAt) {
				fs.byPhone[r.PhoneNumber] = r
			}
		}
		// For persistent mode, multiple records share the same APIKey.
		// Keep the most recently updated one for the byAPIKey index.
		existing, ok := fs.byAPIKey[r.APIKey]
		if !ok || r.UpdatedAt.After(existing.UpdatedAt) {
			fs.byAPIKey[r.APIKey] = r
		}
	}

	fs.byInviteID = map[string]*PersistentInvite{}
	fs.byInviteCode = map[string]*PersistentInvite{}
	fs.byInviteAPIKey = map[string]*PersistentInvite{}
	for _, inv := range fs.invites {
		fs.byInviteID[inv.ID] = inv
		fs.byInviteCode[inv.Code] = inv
		fs.byInviteAPIKey[inv.APIKey] = inv
	}
}

// flush writes all data to disk atomically.
// Must be called with the write lock held.
func (fs *fileStore) flush() error {
	fd := fileData{
		Records:          fs.records,
		Invites:          fs.invites,
		PairRequests:     fs.pairReqs,
		TemplateThrottle: fs.templateThrottle,
	}
	data, err := json.MarshalIndent(fd, "", "  ")
	if err != nil {
		return fmt.Errorf("file store: marshal: %w", err)
	}

	// Write to a temp file in the same directory, then rename for atomicity.
	dir := filepath.Dir(fs.path)
	tmp, err := os.CreateTemp(dir, ".store-*.tmp")
	if err != nil {
		return fmt.Errorf("file store: create temp: %w", err)
	}
	tmpName := tmp.Name()
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("file store: write temp: %w", err)
	}
	if err = tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("file store: close temp: %w", err)
	}
	if err = os.Rename(tmpName, fs.path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("file store: rename: %w", err)
	}
	return nil
}

func (fs *fileStore) CreatePending(record *PairingRecord) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.records = append(fs.records, record)
	fs.byCode[record.PairingCode] = record
	fs.byAPIKey[record.APIKey] = record
	return fs.flush()
}

func (fs *fileStore) FindByPhone(phone string) (*PairingRecord, bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	r, ok := fs.byPhone[phone]
	return r, ok, nil
}

func (fs *fileStore) FindByAPIKey(apiKey string) (*PairingRecord, bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	r, ok := fs.byAPIKey[apiKey]
	return r, ok, nil
}

func (fs *fileStore) ActivatePairing(code string, phone string, now time.Time) (*PairingRecord, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	record, ok := fs.byCode[code]
	if !ok {
		return nil, errors.New("pairing code not found")
	}
	if record.ExpiresAt.Before(now) {
		return nil, errors.New("pairing code expired")
	}

	// Evict any existing active record for the same (wab_number, phone_number).
	for _, r := range fs.records {
		if r.WabNumber == record.WabNumber && r.PhoneNumber == phone &&
			r.Status == StatusActive && r.ID != record.ID {
			r.Status = StatusDisconnected
			r.UpdatedAt = now
		}
	}

	record.PhoneNumber = phone
	record.Status = StatusActive
	record.PairingCode = ""
	record.UpdatedAt = now
	record.LastInboundAt = now
	delete(fs.byCode, code)
	fs.byPhone[phone] = record

	return record, fs.flush()
}

// --- Persistent invite methods ---

func (fs *fileStore) CreateInvite(invite *PersistentInvite) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.invites = append(fs.invites, invite)
	fs.byInviteID[invite.ID] = invite
	fs.byInviteCode[invite.Code] = invite
	fs.byInviteAPIKey[invite.APIKey] = invite
	return fs.flush()
}

func (fs *fileStore) FindInviteByCode(code string) (*PersistentInvite, bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	inv, ok := fs.byInviteCode[code]
	return inv, ok, nil
}

func (fs *fileStore) FindInviteByID(id string) (*PersistentInvite, bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	inv, ok := fs.byInviteID[id]
	return inv, ok, nil
}

func (fs *fileStore) FindInviteByAPIKey(apiKey string) (*PersistentInvite, bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	inv, ok := fs.byInviteAPIKey[apiKey]
	return inv, ok, nil
}

func (fs *fileStore) RevokeInvite(id string, now time.Time) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	inv, ok := fs.byInviteID[id]
	if !ok {
		return errors.New("invite not found")
	}
	inv.RevokedAt = &now
	return fs.flush()
}

func (fs *fileStore) ActivatePersistentPairing(invite *PersistentInvite, phone string, now time.Time) (*PairingRecord, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	// Disconnect any existing active record for this phone on the same WAB number.
	for _, r := range fs.records {
		if r.WabNumber == invite.WabNumber && r.PhoneNumber == phone && r.Status == StatusActive {
			r.Status = StatusDisconnected
			r.UpdatedAt = now
		}
	}

	record := &PairingRecord{
		ID:            uuid.NewString(),
		InstanceID:    invite.InstanceID,
		APIKey:        invite.APIKey,
		PhoneNumber:   phone,
		WabNumber:     invite.WabNumber,
		Status:        StatusActive,
		PairingMode:   ModePersistent,
		InviteID:      invite.ID,
		CreatedAt:     now,
		UpdatedAt:     now,
		LastInboundAt: now,
	}
	fs.records = append(fs.records, record)
	fs.byPhone[phone] = record
	fs.byAPIKey[record.APIKey] = record

	return record, fs.flush()
}

func (fs *fileStore) UpdateLastInboundAt(phone string, ts time.Time) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	changed := false
	for _, r := range fs.records {
		if r.PhoneNumber == phone && r.Status == StatusActive {
			r.LastInboundAt = ts
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return fs.flush()
}

func (fs *fileStore) TrackPairRequest(clientIP string, now time.Time, limit int) (bool, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	oneHourAgo := now.Add(-time.Hour)
	events := fs.pairReqs[clientIP]
	filtered := make([]time.Time, 0, len(events)+1)
	for _, t := range events {
		if t.After(oneHourAgo) {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) >= limit {
		fs.pairReqs[clientIP] = filtered
		return false, fs.flush()
	}
	filtered = append(filtered, now)
	fs.pairReqs[clientIP] = filtered
	return true, fs.flush()
}

func (fs *fileStore) WasTemplateSentRecently(wab, phone, template string, within time.Duration, now time.Time) (bool, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	last, ok := fs.templateThrottle[templateThrottleKey(wab, phone, template)]
	if !ok {
		return false, nil
	}
	return now.Sub(last) < within, nil
}

func (fs *fileStore) MarkTemplateSent(wab, phone, template string, now time.Time) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.templateThrottle[templateThrottleKey(wab, phone, template)] = now
	return fs.flush()
}

func (fs *fileStore) Close() error {
	return nil
}
