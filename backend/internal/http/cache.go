package http

import (
	"sync"

	"github.com/imbee/openclaw-whatsapp-official/backend/internal/store"
)

// recordCache is a write-through in-process cache for PairingRecords.
// It is keyed by both phone number and API key so all hot-path lookups
// (inbound webhook routing and outbound send auth) avoid round-trips to
// the store after the first hit.
type recordCache struct {
	mu       sync.RWMutex
	byPhone  map[string]*store.PairingRecord
	byAPIKey map[string]*store.PairingRecord
}

func newRecordCache() *recordCache {
	return &recordCache{
		byPhone:  make(map[string]*store.PairingRecord),
		byAPIKey: make(map[string]*store.PairingRecord),
	}
}

func (c *recordCache) getByPhone(phone string) (*store.PairingRecord, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	r, ok := c.byPhone[phone]
	return r, ok
}

func (c *recordCache) getByAPIKey(apiKey string) (*store.PairingRecord, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	r, ok := c.byAPIKey[apiKey]
	return r, ok
}

// set stores (or replaces) a record in both indexes.
// Callers must pass the pointer returned directly by the store so the
// cached value always reflects the latest persisted state.
func (c *recordCache) set(r *store.PairingRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.PhoneNumber != "" {
		c.byPhone[r.PhoneNumber] = r
	}
	if r.APIKey != "" {
		c.byAPIKey[r.APIKey] = r
	}
}

// inviteCache is a write-through in-process cache for PersistentInvites.
// Keyed by both invite code and API key.
type inviteCache struct {
	mu       sync.RWMutex
	byCode   map[string]*store.PersistentInvite
	byAPIKey map[string]*store.PersistentInvite
}

func newInviteCache() *inviteCache {
	return &inviteCache{
		byCode:   make(map[string]*store.PersistentInvite),
		byAPIKey: make(map[string]*store.PersistentInvite),
	}
}

func (c *inviteCache) getByCode(code string) (*store.PersistentInvite, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	inv, ok := c.byCode[code]
	if ok && inv.RevokedAt != nil {
		return nil, false // treat revoked as miss
	}
	return inv, ok
}

func (c *inviteCache) getByAPIKey(apiKey string) (*store.PersistentInvite, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	inv, ok := c.byAPIKey[apiKey]
	if ok && inv.RevokedAt != nil {
		return nil, false
	}
	return inv, ok
}

func (c *inviteCache) set(inv *store.PersistentInvite) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byCode[inv.Code] = inv
	c.byAPIKey[inv.APIKey] = inv
}

// evict removes a revoked invite from the cache so subsequent lookups miss
// and fall through to the store (which will also return not-found for revoked).
func (c *inviteCache) evict(inviteID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for code, inv := range c.byCode {
		if inv.ID == inviteID {
			delete(c.byCode, code)
			delete(c.byAPIKey, inv.APIKey)
			return
		}
	}
}
