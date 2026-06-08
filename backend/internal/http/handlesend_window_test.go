package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imbee/openclaw-whatsapp-official/backend/internal/config"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/store"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/whatsapp"
)

// fakeProvider is a controllable whatsapp.Provider for handleSend tests.
// Each behaviour hook is a closure so individual tests can wire just what they need.
type fakeProvider struct {
	mu                 sync.Mutex
	sendTextFn         func(to, text string) (string, error)
	sendTemplateFn     func(to, name, lang string, components []whatsapp.TemplateComponent) (string, error)
	sendTextCalls      int
	sendTemplateCalls  int
	lastTemplateName   string
	lastTemplateLang   string
	lastTemplateButton string // payload extracted from components[0] if shaped like a quick-reply
}

func (f *fakeProvider) SendText(_ context.Context, to, text string) (string, error) {
	f.mu.Lock()
	f.sendTextCalls++
	fn := f.sendTextFn
	f.mu.Unlock()
	if fn == nil {
		return "wamid.default", nil
	}
	return fn(to, text)
}

func (f *fakeProvider) SendMedia(_ context.Context, _, _, _, _, _ string) (string, error) {
	return "wamid.media", nil
}

func (f *fakeProvider) SendTemplate(_ context.Context, to, name, lang string, components []whatsapp.TemplateComponent) (string, error) {
	f.mu.Lock()
	f.sendTemplateCalls++
	f.lastTemplateName = name
	f.lastTemplateLang = lang
	f.lastTemplateButton = extractButtonPayload(components)
	fn := f.sendTemplateFn
	f.mu.Unlock()
	if fn == nil {
		return "wamid.template", nil
	}
	return fn(to, name, lang, components)
}

func (f *fakeProvider) DownloadMedia(_ context.Context, _, _ string) ([]byte, string, error) {
	return nil, "", nil
}
func (f *fakeProvider) SendTypingIndicator(_ context.Context, _ string) error { return nil }
func (f *fakeProvider) ValidateWebhook(_ *http.Request, _ []byte) bool        { return true }

func extractButtonPayload(components []whatsapp.TemplateComponent) string {
	for _, c := range components {
		if c.Type != "button" || c.SubType != "quick_reply" {
			continue
		}
		for _, p := range c.Parameters {
			if p.Type == "payload" {
				return p.Payload
			}
		}
	}
	return ""
}

// testRig is a Server constructed with the minimal subset of fields handleSend
// touches. pairingSvc, hub, invites, brute-force maps stay nil/zero — the send
// path doesn't reach them.
type testRig struct {
	server   *Server
	store    *store.Memory
	provider *fakeProvider
	record   *store.PairingRecord
}

func newTestRig(t *testing.T) *testRig {
	t.Helper()
	mem := store.NewMemory()
	rec := &store.PairingRecord{
		ID:          "rec-1",
		InstanceID:  "inst-1",
		APIKey:      "key-1",
		PhoneNumber: "+85296707776",
		WabNumber:   "+85230013143",
		Status:      store.StatusActive,
	}
	// Prime the cache so handleSend's hot path matches reality. We do NOT
	// seed the store with the pairing record: handleSend hits the cache first,
	// the store is only consulted for throttle reads/writes.
	prov := &fakeProvider{}
	cache := newRecordCache()
	cache.set(rec)
	cfg := config.Config{
		ReengagementTemplateName:  "smart_session_test",
		ReengagementTemplateLang:  "en",
		ReengagementButtonPayload: "READ_NOW",
		TemplateThrottleHours:     24 * time.Hour,
	}
	srv := &Server{
		cfg:        cfg,
		store:      mem,
		cache:      cache,
		invites:    newInviteCache(),
		waProvider: prov,
	}
	return &testRig{server: srv, store: mem, provider: prov, record: rec}
}

// doSend posts a text send to /api/v1/send and returns the recorder.
func (r *testRig) doSend(t *testing.T, text string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"toPhoneNumber":%q,"text":%q}`, r.record.PhoneNumber, text)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/send", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+r.record.APIKey)
	rec := httptest.NewRecorder()
	r.server.handleSend(rec, req)
	return rec
}

// AC-S01: SendText succeeds → 200 {status:"accepted", messageId}.
func TestHandleSend_Accepted(t *testing.T) {
	r := newTestRig(t)
	r.provider.sendTextFn = func(to, text string) (string, error) {
		return "wamid.ok-1", nil
	}
	resp := r.doSend(t, "hello")
	if resp.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", resp.Code, resp.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatalf("json: %v body=%s", err, resp.Body.String())
	}
	if got["status"] != "accepted" {
		t.Errorf("status: got %q, want %q", got["status"], "accepted")
	}
	if got["messageId"] != "wamid.ok-1" {
		t.Errorf("messageId: got %q, want %q", got["messageId"], "wamid.ok-1")
	}
	if r.provider.sendTemplateCalls != 0 {
		t.Errorf("SendTemplate must not be called on the happy path; got %d", r.provider.sendTemplateCalls)
	}
}

// AC-S02: SendText returns ErrWindowClosed, no throttle row, SendTemplate
// succeeds → 200 {status:"window_closed", templateSent:true}; throttle row
// written; template-send carries the configured payload override.
func TestHandleSend_WindowClosed_TemplateSent(t *testing.T) {
	r := newTestRig(t)
	r.provider.sendTextFn = func(string, string) (string, error) {
		return "", whatsapp.ErrWindowClosed
	}
	resp := r.doSend(t, "hello")
	if resp.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", resp.Code, resp.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatalf("json: %v body=%s", err, resp.Body.String())
	}
	if got["status"] != "window_closed" {
		t.Errorf("status: got %v, want %q", got["status"], "window_closed")
	}
	if got["templateSent"] != true {
		t.Errorf("templateSent: got %v, want true", got["templateSent"])
	}
	if r.provider.sendTemplateCalls != 1 {
		t.Errorf("SendTemplate calls: got %d, want 1", r.provider.sendTemplateCalls)
	}
	if r.provider.lastTemplateName != "smart_session_test" {
		t.Errorf("template name: got %q, want smart_session_test", r.provider.lastTemplateName)
	}
	if r.provider.lastTemplateButton != "READ_NOW" {
		t.Errorf("button payload override: got %q, want READ_NOW", r.provider.lastTemplateButton)
	}
	// Throttle row written.
	recent, _ := r.store.WasTemplateSentRecently(r.record.WabNumber, r.record.PhoneNumber, "smart_session_test", 24*time.Hour, time.Now().UTC())
	if !recent {
		t.Error("expected throttle row to be written after successful template send")
	}
}

// AC-S03: SendText returns ErrWindowClosed but a throttle row already exists
// within the cooldown → 200 {status:"window_closed", templateSent:false};
// SendTemplate is NOT called again.
func TestHandleSend_WindowClosed_Throttled(t *testing.T) {
	r := newTestRig(t)
	if err := r.store.MarkTemplateSent(r.record.WabNumber, r.record.PhoneNumber, "smart_session_test", time.Now().UTC()); err != nil {
		t.Fatalf("seed throttle: %v", err)
	}
	r.provider.sendTextFn = func(string, string) (string, error) {
		return "", whatsapp.ErrWindowClosed
	}
	resp := r.doSend(t, "hello")
	if resp.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", resp.Code, resp.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatalf("json: %v", err)
	}
	if got["status"] != "window_closed" {
		t.Errorf("status: got %v, want %q", got["status"], "window_closed")
	}
	if got["templateSent"] != false {
		t.Errorf("templateSent: got %v, want false", got["templateSent"])
	}
	if r.provider.sendTemplateCalls != 0 {
		t.Errorf("SendTemplate must not be called when throttled; got %d", r.provider.sendTemplateCalls)
	}
}

// AC-S04: SendText returns ErrWindowClosed, SendTemplate fails → 200
// {status:"window_closed", templateSent:false}; throttle row is NOT written
// (so a future attempt can retry the template).
func TestHandleSend_WindowClosed_TemplateFailed(t *testing.T) {
	r := newTestRig(t)
	r.provider.sendTextFn = func(string, string) (string, error) {
		return "", whatsapp.ErrWindowClosed
	}
	r.provider.sendTemplateFn = func(string, string, string, []whatsapp.TemplateComponent) (string, error) {
		return "", errors.New("provider 500: template render failed")
	}
	resp := r.doSend(t, "hello")
	if resp.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", resp.Code, resp.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatalf("json: %v", err)
	}
	if got["status"] != "window_closed" {
		t.Errorf("status: got %v, want %q", got["status"], "window_closed")
	}
	if got["templateSent"] != false {
		t.Errorf("templateSent: got %v, want false", got["templateSent"])
	}
	if r.provider.sendTemplateCalls != 1 {
		t.Errorf("SendTemplate calls: got %d, want 1", r.provider.sendTemplateCalls)
	}
	// Throttle row must NOT be written on a failed send — next attempt should retry.
	recent, _ := r.store.WasTemplateSentRecently(r.record.WabNumber, r.record.PhoneNumber, "smart_session_test", 24*time.Hour, time.Now().UTC())
	if recent {
		t.Error("throttle row must not be written when SendTemplate fails")
	}
}
