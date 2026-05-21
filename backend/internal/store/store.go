package store

import "time"

type Status string

const (
	StatusPending      Status = "PENDING"
	StatusActive       Status = "ACTIVE"
	StatusDisconnected Status = "DISCONNECTED"
)

type PairingMode string

const (
	ModeSingleUse  PairingMode = "single_use"
	ModePersistent PairingMode = "persistent"
)

type PairingRecord struct {
	ID          string
	InstanceID  string
	APIKey      string
	PairingCode string
	PhoneNumber string
	WabNumber   string
	Status      Status
	PairingMode PairingMode // "single_use" or "persistent"
	InviteID    string      // non-empty when PairingMode == ModePersistent
	ExpiresAt   time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// PersistentInvite is a reusable pairing code tied to one instance.
// Any phone that sends the code is paired to the instance; the code
// remains active until explicitly revoked.
type PersistentInvite struct {
	ID         string
	InstanceID string
	APIKey     string
	Code       string
	WabNumber  string
	CreatedAt  time.Time
	RevokedAt  *time.Time // nil = active
}

type Repository interface {
	// Single-use pairing
	CreatePending(record *PairingRecord) error
	FindByPhone(phone string) (*PairingRecord, bool, error)
	FindByAPIKey(apiKey string) (*PairingRecord, bool, error)
	ActivatePairing(code string, phone string, now time.Time) (*PairingRecord, error)

	// Persistent invite pairing
	CreateInvite(invite *PersistentInvite) error
	FindInviteByCode(code string) (*PersistentInvite, bool, error)
	FindInviteByID(id string) (*PersistentInvite, bool, error)
	FindInviteByAPIKey(apiKey string) (*PersistentInvite, bool, error)
	RevokeInvite(id string, now time.Time) error
	ActivatePersistentPairing(invite *PersistentInvite, phone string, now time.Time) (*PairingRecord, error)

	// Rate limiting
	TrackPairRequest(clientIP string, now time.Time, limit int) (bool, error)

	Close() error
}
