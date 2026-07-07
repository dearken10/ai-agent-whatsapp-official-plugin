package store

import (
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Memory struct {
	mu                sync.RWMutex
	byCode            map[string]*PairingRecord
	byPhone           map[string]*PairingRecord
	byInstance        map[string][]*PairingRecord
	byAPIKey          map[string]*PairingRecord
	pairRequestsByIns map[string][]time.Time

	// Persistent invite indexes
	invitesByID      map[string]*PersistentInvite
	invitesByCode    map[string]*PersistentInvite
	invitesByAPIKey  map[string]*PersistentInvite

	// Template throttle: keyed by templateThrottleKey(wab, phone, template).
	templateLastSentAt map[string]time.Time
}

func NewMemory() *Memory {
	return &Memory{
		byCode:             map[string]*PairingRecord{},
		byPhone:            map[string]*PairingRecord{},
		byInstance:         map[string][]*PairingRecord{},
		byAPIKey:           map[string]*PairingRecord{},
		pairRequestsByIns:  map[string][]time.Time{},
		invitesByID:        map[string]*PersistentInvite{},
		invitesByCode:      map[string]*PersistentInvite{},
		invitesByAPIKey:    map[string]*PersistentInvite{},
		templateLastSentAt: map[string]time.Time{},
	}
}

// templateThrottleKey forms the composite key for the template throttle map.
// The plus-separator works because phone numbers and template names cannot
// contain '+' in legal WhatsApp / template-name characters (E.164 phones
// canonicalise to leading-`+` digits and template names are `[a-z0-9_]+`).
func templateThrottleKey(wab, phone, template string) string {
	return wab + "+" + phone + "+" + template
}

func (m *Memory) CreatePending(record *PairingRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byCode[record.PairingCode] = record
	m.byAPIKey[record.APIKey] = record
	m.byInstance[record.InstanceID] = append(m.byInstance[record.InstanceID], record)
	return nil
}

func (m *Memory) FindByCode(code string) (*PairingRecord, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	record, ok := m.byCode[code]
	return record, ok
}

func (m *Memory) FindByPhone(phone string) (*PairingRecord, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	record, ok := m.byPhone[phone]
	return record, ok, nil
}

func (m *Memory) FindByAPIKey(apiKey string) (*PairingRecord, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	record, ok := m.byAPIKey[apiKey]
	return record, ok, nil
}

func (m *Memory) ActivatePairing(code string, phone string, now time.Time) (*PairingRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.byCode[code]
	if !ok {
		return nil, errors.New("pairing code not found")
	}
	if record.ExpiresAt.Before(now) {
		return nil, errors.New("pairing code expired")
	}
	record.PhoneNumber = phone
	record.Status = StatusActive
	record.PairingCode = ""
	record.UpdatedAt = now
	record.LastInboundAt = now
	delete(m.byCode, code)
	m.byPhone[phone] = record
	return record, nil
}

// --- Persistent invite methods ---

func (m *Memory) CreateInvite(invite *PersistentInvite) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invitesByID[invite.ID] = invite
	m.invitesByCode[invite.Code] = invite
	m.invitesByAPIKey[invite.APIKey] = invite
	return nil
}

func (m *Memory) FindInviteByCode(code string) (*PersistentInvite, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inv, ok := m.invitesByCode[code]
	return inv, ok, nil
}

func (m *Memory) FindInviteByID(id string) (*PersistentInvite, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inv, ok := m.invitesByID[id]
	return inv, ok, nil
}

func (m *Memory) FindInviteByAPIKey(apiKey string) (*PersistentInvite, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inv, ok := m.invitesByAPIKey[apiKey]
	return inv, ok, nil
}

func (m *Memory) RevokeInvite(id string, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	inv, ok := m.invitesByID[id]
	if !ok {
		return errors.New("invite not found")
	}
	inv.RevokedAt = &now
	return nil
}

func (m *Memory) ActivatePersistentPairing(invite *PersistentInvite, phone string, now time.Time) (*PairingRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Disconnect any existing active record for this phone on the same WAB number.
	if existing, ok := m.byPhone[phone]; ok && existing.WabNumber == invite.WabNumber {
		existing.Status = StatusDisconnected
		existing.UpdatedAt = now
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
	m.byPhone[phone] = record
	m.byInstance[record.InstanceID] = append(m.byInstance[record.InstanceID], record)
	// Note: multiple phones share the same APIKey in persistent mode; we overwrite
	// byAPIKey with the most recent pairing (used for WS auth fallback only).
	m.byAPIKey[record.APIKey] = record
	return record, nil
}

func (m *Memory) UpdateLastInboundAt(phone string, ts time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.byPhone[phone]; ok {
		r.LastInboundAt = ts
	}
	// byInstance may hold additional ACTIVE records for the same phone under
	// different pairings (persistent mode across WABs); refresh those too so
	// whichever record wins a lookup carries the latest timestamp.
	for _, records := range m.byInstance {
		for _, r := range records {
			if r.PhoneNumber == phone && r.Status == StatusActive {
				r.LastInboundAt = ts
			}
		}
	}
	return nil
}

func (m *Memory) TrackPairRequest(clientIP string, now time.Time, limit int) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	oneHourAgo := now.Add(-1 * time.Hour)
	events := m.pairRequestsByIns[clientIP]
	filtered := make([]time.Time, 0, len(events)+1)
	for _, t := range events {
		if t.After(oneHourAgo) {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) >= limit {
		m.pairRequestsByIns[clientIP] = filtered
		return false, nil
	}
	filtered = append(filtered, now)
	m.pairRequestsByIns[clientIP] = filtered
	return true, nil
}

func (m *Memory) WasTemplateSentRecently(wab, phone, template string, within time.Duration, now time.Time) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	last, ok := m.templateLastSentAt[templateThrottleKey(wab, phone, template)]
	if !ok {
		return false, nil
	}
	return now.Sub(last) < within, nil
}

func (m *Memory) MarkTemplateSent(wab, phone, template string, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.templateLastSentAt[templateThrottleKey(wab, phone, template)] = now
	return nil
}

func (m *Memory) Close() error {
	return nil
}
