package store

import (
	"path/filepath"
	"testing"
	"time"
)

// Each driver must expose the same UpdateLastInboundAt semantics: it stamps
// the timestamp on every ACTIVE row for the phone, leaves DISCONNECTED rows
// alone, and no-ops silently for unknown phones. Test all three so the
// interface can't silently drift.
func TestUpdateLastInboundAt_AllDrivers(t *testing.T) {
	cases := []struct {
		name string
		make func(t *testing.T) Repository
	}{
		{"memory", func(t *testing.T) Repository { return NewMemory() }},
		{"file", func(t *testing.T) Repository {
			r, err := NewFile(filepath.Join(t.TempDir(), "store.json"))
			if err != nil {
				t.Fatalf("NewFile: %v", err)
			}
			return r
		}},
		{"sqlite", func(t *testing.T) Repository {
			r, err := NewSQLite(filepath.Join(t.TempDir(), "store.db"))
			if err != nil {
				t.Fatalf("NewSQLite: %v", err)
			}
			return r
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := tc.make(t)
			t.Cleanup(func() { _ = repo.Close() })

			// Seed an ACTIVE pairing via the invite path — the shortest route
			// that exercises the full write-then-read cycle on every driver.
			inv := &PersistentInvite{
				ID:         "inv-1",
				InstanceID: "inst-1",
				APIKey:     "key-1",
				Code:       "CLAW-TEST-0001",
				WabNumber:  "+18064509684",
				CreatedAt:  time.Now().UTC(),
			}
			if err := repo.CreateInvite(inv); err != nil {
				t.Fatalf("CreateInvite: %v", err)
			}
			pairedAt := time.Now().UTC().Truncate(time.Second)
			rec, err := repo.ActivatePersistentPairing(inv, "85296707776", pairedAt)
			if err != nil {
				t.Fatalf("ActivatePersistentPairing: %v", err)
			}
			// Activation itself must stamp LastInboundAt (the code message
			// is a user inbound). Persistent activation returns a fresh
			// record with LastInboundAt already set to `now`.
			if rec.LastInboundAt.IsZero() {
				t.Errorf("ActivatePersistentPairing did not stamp LastInboundAt")
			}

			// Update to a later timestamp.
			later := pairedAt.Add(2 * time.Hour)
			if err := repo.UpdateLastInboundAt("85296707776", later); err != nil {
				t.Fatalf("UpdateLastInboundAt: %v", err)
			}
			// Read back and confirm.
			got, ok, err := repo.FindByPhone("85296707776")
			if err != nil || !ok {
				t.Fatalf("FindByPhone: ok=%v err=%v", ok, err)
			}
			if !got.LastInboundAt.Equal(later) {
				t.Errorf("LastInboundAt: got %s, want %s", got.LastInboundAt, later)
			}

			// Unknown phone must not error — this is the fire-and-forget
			// contract routeIncoming relies on.
			if err := repo.UpdateLastInboundAt("nobody", later); err != nil {
				t.Errorf("UpdateLastInboundAt for unknown phone must not error, got %v", err)
			}
		})
	}
}
