package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/config"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/pairing"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/store"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/webhook"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/whatsapp"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/ws"
)

var pairingCodeRegex = regexp.MustCompile(`^CLAW-[A-Z0-9]{4}-[A-Z0-9]{4}$`)

type Server struct {
	cfg        config.Config
	store      store.Repository
	pairingSvc *pairing.Service
	hub        *ws.Hub
	cache      *recordCache
	invites    *inviteCache
	waProvider whatsapp.Provider
	upgrader   websocket.Upgrader

	// Brute-force protection state (all guarded by bfMu)
	bfMu            sync.Mutex
	bfPhoneAttempts map[string][]time.Time // phone → wrong attempt timestamps within window
	bfPhoneBlocked  map[string]time.Time   // phone → unblock time
	bfPhoneNotified map[string]bool        // phone → notification sent for current block period
	bfGlobalEvents  []time.Time            // global code-format message timestamps (last minute)
}

func NewServer(cfg config.Config) (*Server, error) {
	var (
		st  store.Repository
		err error
	)
	switch strings.ToLower(cfg.StoreDriver) {
	case "sqlite":
		st, err = store.NewSQLite(cfg.StoreFilePath)
	case "file":
		st, err = store.NewFile(cfg.StoreFilePath)
	default:
		st = store.NewMemory()
	}
	if err != nil {
		return nil, err
	}

	waProvider, err := whatsapp.New(whatsapp.Config{
		Provider:          cfg.WAProvider,
		WABAToken:         cfg.WABAToken,
		WABAPhoneNumberID: cfg.WABAPhoneNumberID,
		WebhookAppSecret:  cfg.WebhookAppSecret,
		D360APIKey:        cfg.D360APIKey,
		D360BaseURL:       cfg.D360BaseURL,
	})
	if err != nil {
		return nil, err
	}
	provider := cfg.WAProvider
	if provider == "" {
		provider = "stub"
	}
	keyHint := "(none)"
	if cfg.D360APIKey != "" {
		k := cfg.D360APIKey
		if len(k) > 8 {
			keyHint = k[:4] + "…" + k[len(k)-4:]
		} else {
			keyHint = k[:1] + "…"
		}
	}
	log.Printf("[server] provider=%s shared_number=%s d360_key=%s",
		provider, cfg.SharedNumber, keyHint)

	return &Server{
		cfg:             cfg,
		store:           st,
		pairingSvc:      pairing.NewService(cfg, st),
		hub:             ws.NewHub(),
		cache:           newRecordCache(),
		invites:         newInviteCache(),
		waProvider:      waProvider,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		bfPhoneAttempts: make(map[string][]time.Time),
		bfPhoneBlocked:  make(map[string]time.Time),
		bfPhoneNotified: make(map[string]bool),
	}, nil
}

func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/healthz", s.handleHealth).Methods(http.MethodGet)
	r.HandleFunc("/api/v1/pair/request", s.handlePairRequest).Methods(http.MethodPost)
	r.HandleFunc("/api/v1/pair/invite", s.handleInviteGet).Methods(http.MethodGet)
	r.HandleFunc("/api/v1/pair/invite/{inviteId}", s.handleInviteDelete).Methods(http.MethodDelete)
	r.HandleFunc("/api/v1/pair/status", s.handlePairStatus).Methods(http.MethodGet)
	r.HandleFunc("/api/v1/send", s.handleSend).Methods(http.MethodPost)
	r.HandleFunc("/api/v1/send-media", s.handleSendMedia).Methods(http.MethodPost)
	r.HandleFunc("/api/v1/typing", s.handleTyping).Methods(http.MethodPost)
	r.HandleFunc("/api/v1/media/{mediaId}", s.handleMediaDownload).Methods(http.MethodGet)
	r.HandleFunc("/webhooks/whatsapp", s.handleWebhookVerify).Methods(http.MethodGet)
	r.HandleFunc("/webhooks/whatsapp", s.handleWebhook).Methods(http.MethodPost)
	r.HandleFunc("/ws", s.handleWS).Methods(http.MethodGet)
	return r
}

func (s *Server) Close() error {
	if s.store == nil {
		return nil
	}
	return s.store.Close()
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handlePairRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode string `json:"mode"` // "single_use" (default) or "persistent"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Empty body is fine — treat as single_use default.
		req.Mode = ""
	}

	ip := clientIP(r)

	if req.Mode == "persistent" {
		invite, err := s.pairingSvc.CreatePersistentInvite(ip)
		if err != nil {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
			return
		}
		s.invites.set(invite)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"mode":       "persistent",
			"inviteId":   invite.ID,
			"instanceId": invite.InstanceID,
			"pairingCode": invite.Code,
			"waMeUrl":    pairing.WaMeURL(s.cfg.SharedNumber, invite.Code),
			"apiKey":     invite.APIKey,
			"wabNumber":  invite.WabNumber,
		})
		return
	}

	// Default: single-use
	record, err := s.pairingSvc.CreatePairing(ip)
	if err != nil {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"mode":        "single_use",
		"instanceId":  record.InstanceID,
		"pairingCode": record.PairingCode,
		"expiresAt":   record.ExpiresAt.Format(time.RFC3339),
		"waMeUrl":     pairing.WaMeURL(s.cfg.SharedNumber, record.PairingCode),
		"apiKey":      record.APIKey,
		"wabNumber":   record.WabNumber,
	})
}

// handleInviteGet returns the active persistent invite for the authenticated instance.
func (s *Server) handleInviteGet(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	inv, ok := s.invites.getByAPIKey(apiKey)
	if !ok {
		var err error
		inv, ok, err = s.store.FindInviteByAPIKey(apiKey)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store error"})
			return
		}
		if ok {
			s.invites.set(inv)
		}
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no active invite found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"inviteId":    inv.ID,
		"instanceId":  inv.InstanceID,
		"pairingCode": inv.Code,
		"waMeUrl":     pairing.WaMeURL(s.cfg.SharedNumber, inv.Code),
		"wabNumber":   inv.WabNumber,
		"createdAt":   inv.CreatedAt.Format(time.RFC3339),
	})
}

// handleInviteDelete revokes a persistent invite by ID.
func (s *Server) handleInviteDelete(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	inviteID := mux.Vars(r)["inviteId"]
	// Verify ownership: the invite's API key must match the request's bearer token.
	inv, ok, err := s.store.FindInviteByID(inviteID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store error"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invite not found"})
		return
	}
	if inv.APIKey != apiKey {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not authorized to revoke this invite"})
		return
	}
	if err = s.store.RevokeInvite(inviteID, time.Now().UTC()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "revoke failed: " + err.Error()})
		return
	}
	s.invites.evict(inviteID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (s *Server) handlePairStatus(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	record, ok := s.cache.getByAPIKey(apiKey)
	if !ok {
		var err error
		record, ok, err = s.store.FindByAPIKey(apiKey)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store error"})
			return
		}
		if ok {
			s.cache.set(record)
		}
	}
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":      string(record.Status),
		"phoneNumber": record.PhoneNumber,
	})
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	var req struct {
		ToPhoneNumber string `json:"toPhoneNumber"`
		Text          string `json:"text"`
		MediaURL      string `json:"mediaUrl"`
		MediaType     string `json:"mediaType"`
		Caption       string `json:"caption"`
		FileName      string `json:"fileName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Text == "" && req.MediaURL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text or mediaUrl is required"})
		return
	}

	// Validate that the target phone is actively paired via this API key.
	// For persistent mode, multiple phones share the same API key, so we look
	// up by phone number and verify the API key matches rather than the reverse.
	targetRecord, ok := s.cache.getByPhone(req.ToPhoneNumber)
	if !ok {
		var err error
		targetRecord, ok, err = s.store.FindByPhone(req.ToPhoneNumber)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store error"})
			return
		}
		if ok {
			s.cache.set(targetRecord)
		}
	}
	if !ok || targetRecord.Status != store.StatusActive {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "target not paired or inactive"})
		return
	}
	if targetRecord.APIKey != apiKey {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "target mismatch: phone not paired to this instance"})
		return
	}

	// Proactive 24h-window check. 360dialog silently accepts free-form sends
	// outside the window (HTTP 200 + wamid) and WhatsApp drops them downstream,
	// so the provider's ErrWindowClosed signal is unreliable. We short-circuit
	// to the re-engagement template path when our recorded LastInboundAt is
	// stale. WindowHours == 0 disables the check (compat / tests).
	if s.cfg.WindowHours > 0 && windowExpired(targetRecord.LastInboundAt, time.Now().UTC(), s.cfg.WindowHours) {
		templateSent := s.dispatchReengagementTemplate(r.Context(), targetRecord.WabNumber, req.ToPhoneNumber)
		log.Printf("[send] window_closed_proactive to=%s last_inbound=%s templateSent=%v",
			maskPhone(req.ToPhoneNumber), targetRecord.LastInboundAt.Format(time.RFC3339), templateSent)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":       "window_closed",
			"templateSent": templateSent,
		})
		return
	}

	var (
		messageID string
		sendErr   error
	)
	if req.MediaURL != "" {
		mediaType := req.MediaType
		if mediaType == "" {
			mediaType = "document"
		}
		messageID, sendErr = s.waProvider.SendMedia(r.Context(), req.ToPhoneNumber, mediaType, req.MediaURL, req.Caption, req.FileName)
	} else {
		messageID, sendErr = s.waProvider.SendText(r.Context(), req.ToPhoneNumber, req.Text)
	}
	if sendErr == nil {
		writeJSON(w, http.StatusOK, map[string]string{
			"status":    "accepted",
			"messageId": messageID,
		})
		return
	}

	// 24h window closed: best-effort template dispatch + tell plugin to buffer.
	// The server-side template_throttle store guarantees at most one billable
	// template send per (wab, phone, template) per TEMPLATE_THROTTLE_HOURS,
	// regardless of how the plugin behaves.
	if errors.Is(sendErr, whatsapp.ErrWindowClosed) {
		templateSent := s.dispatchReengagementTemplate(r.Context(), targetRecord.WabNumber, req.ToPhoneNumber)
		log.Printf("[send] window_closed to=%s templateSent=%v", maskPhone(req.ToPhoneNumber), templateSent)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":       "window_closed",
			"templateSent": templateSent,
		})
		return
	}

	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "send failed: " + sendErr.Error()})
}

// windowExpired reports whether the recorded last-inbound timestamp is far
// enough in the past that a free-form outbound would fall outside WhatsApp's
// 24h customer service window. A zero timestamp (no inbound ever observed —
// legacy row from before this field existed, or a pairing that never
// exchanged messages) is treated as expired: safer to send a re-engagement
// template than to silently drop a message.
func windowExpired(lastInbound, now time.Time, window time.Duration) bool {
	if lastInbound.IsZero() {
		return true
	}
	return now.Sub(lastInbound) >= window
}

// dispatchReengagementTemplate consults the throttle store and, if not recently
// sent, fires the configured re-engagement template via the active provider.
// Returns whether the template was actually delivered to the provider in this
// call. A failure or throttle hit both return false; only a successful send
// records the timestamp so a failed attempt does not consume the cooldown.
func (s *Server) dispatchReengagementTemplate(ctx context.Context, wab, phone string) bool {
	now := time.Now().UTC()
	template := s.cfg.ReengagementTemplateName
	recently, err := s.store.WasTemplateSentRecently(wab, phone, template, s.cfg.TemplateThrottleHours, now)
	if err != nil {
		log.Printf("[template] throttle lookup error wab=%s phone=%s err=%v", wab, maskPhone(phone), err)
		// On store error, err on the side of caution: do NOT send (avoid duplicate spam).
		return false
	}
	if recently {
		log.Printf("[template] throttled wab=%s phone=%s template=%s", wab, maskPhone(phone), template)
		return false
	}
	// Attach a quick-reply payload override so the user's tap echoes back
	// ReengagementButtonPayload (the value isReengagementButtonReply matches on),
	// not the button's visible label. WhatsApp templates only fix the button
	// text at approval time; the payload is per-send.
	components := []whatsapp.TemplateComponent{{
		Type:    "button",
		SubType: "quick_reply",
		Index:   "0",
		Parameters: []whatsapp.TemplateParameter{
			{Type: "payload", Payload: s.cfg.ReengagementButtonPayload},
		},
	}}
	if _, sendErr := s.waProvider.SendTemplate(ctx, phone, template, s.cfg.ReengagementTemplateLang, components); sendErr != nil {
		log.Printf("[template] send failed wab=%s phone=%s template=%s err=%v", wab, maskPhone(phone), template, sendErr)
		return false
	}
	if err := s.store.MarkTemplateSent(wab, phone, template, now); err != nil {
		log.Printf("[template] mark sent failed wab=%s phone=%s err=%v", wab, maskPhone(phone), err)
	}
	log.Printf("[template] sent wab=%s phone=%s template=%s", wab, maskPhone(phone), template)
	return true
}

// handleSendMedia accepts a multipart upload and forwards the file to the
// underlying provider via SendFileMedia (no public URL required).
//
// Form fields (multipart/form-data):
//   - toPhoneNumber  (required) — E.164 without '+'
//   - file           (required) — the file to send
//   - mediaType      (optional) — "document" (default), "image", "video", "audio"
//   - caption        (optional) — visible caption (documents/images/videos)
//   - mimeType       (optional) — overrides the inferred Content-Type
//   - fileName       (optional) — overrides the uploaded filename
func (s *Server) handleSendMedia(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}

	// Cap upload size at 32 MB. WhatsApp's hard limit is 100 MB for documents
	// but 32 MB is a sane default that covers receipts, CSVs, small PDFs.
	const maxUpload = 32 << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	if err := r.ParseMultipartForm(maxUpload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "multipart parse failed: " + err.Error()})
		return
	}

	to := strings.TrimSpace(r.FormValue("toPhoneNumber"))
	if to == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "toPhoneNumber is required"})
		return
	}
	mediaType := r.FormValue("mediaType")
	if mediaType == "" {
		mediaType = "document"
	}
	switch mediaType {
	case "document", "image", "video", "audio":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mediaType must be one of: document, image, video, audio"})
		return
	}
	caption := r.FormValue("caption")
	overrideMime := r.FormValue("mimeType")
	overrideName := r.FormValue("fileName")

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file field is required: " + err.Error()})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read file failed: " + err.Error()})
		return
	}
	mimeType := overrideMime
	if mimeType == "" {
		if ct := header.Header.Get("Content-Type"); ct != "" {
			mimeType = ct
		} else {
			mimeType = http.DetectContentType(data)
		}
	}
	filename := overrideName
	if filename == "" {
		filename = header.Filename
	}

	// Validate that the target phone is actively paired via this API key.
	targetRecord, ok := s.cache.getByPhone(to)
	if !ok {
		targetRecord, ok, err = s.store.FindByPhone(to)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store error"})
			return
		}
		if ok {
			s.cache.set(targetRecord)
		}
	}
	if !ok || targetRecord.Status != store.StatusActive {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "target not paired or inactive"})
		return
	}
	if targetRecord.APIKey != apiKey {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "target mismatch: phone not paired to this instance"})
		return
	}

	// Same proactive 24h-window guard as handleSend — see comment there for
	// why we do not trust the provider's error signal.
	if s.cfg.WindowHours > 0 && windowExpired(targetRecord.LastInboundAt, time.Now().UTC(), s.cfg.WindowHours) {
		templateSent := s.dispatchReengagementTemplate(r.Context(), targetRecord.WabNumber, to)
		log.Printf("[send-media] window_closed_proactive to=%s last_inbound=%s templateSent=%v",
			maskPhone(to), targetRecord.LastInboundAt.Format(time.RFC3339), templateSent)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":       "window_closed",
			"templateSent": templateSent,
		})
		return
	}

	messageID, sendErr := s.waProvider.SendFileMedia(r.Context(), to, mediaType, mimeType, filename, data, caption)
	if sendErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "send failed: " + sendErr.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":    "accepted",
		"messageId": messageID,
	})
}

func (s *Server) handleTyping(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	if !s.isValidAPIKey(apiKey) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "inactive or invalid token"})
		return
	}
	var req struct {
		MessageID string `json:"messageId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MessageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "messageId is required"})
		return
	}
	_ = s.waProvider.SendTypingIndicator(r.Context(), req.MessageID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMediaDownload(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	if !s.isValidAPIKey(apiKey) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid token"})
		return
	}
	mediaID := mux.Vars(r)["mediaId"]
	directURL := r.URL.Query().Get("url")
	data, mimeType, err := s.waProvider.DownloadMedia(r.Context(), mediaID, directURL)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "media download failed: " + err.Error()})
		return
	}
	if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleWebhookVerify responds to Meta's GET challenge when registering the webhook URL.
func (s *Server) handleWebhookVerify(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("hub.mode") != "subscribe" {
		http.Error(w, "invalid mode", http.StatusForbidden)
		return
	}
	if s.cfg.WebhookVerifyToken == "" || q.Get("hub.verify_token") != s.cfg.WebhookVerifyToken {
		http.Error(w, "token mismatch", http.StatusForbidden)
		return
	}
	challenge := q.Get("hub.challenge")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(challenge))
}

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	log.Printf("[webhook] received %d bytes", len(body))
	if !s.waProvider.ValidateWebhook(r, body) {
		log.Printf("[webhook] signature validation failed (ip=%s)", clientIP(r))
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid signature"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

	var payload webhook.MetaWebhookPayload
	if err = json.Unmarshal(body, &payload); err != nil {
		log.Printf("[webhook] unmarshal error: %v", err)
		return
	}
	for _, entry := range payload.Entry {
		for _, change := range entry.Changes {
			log.Printf("[webhook] %d message(s)", len(change.Value.Messages))
			for _, message := range change.Value.Messages {
				s.routeIncoming(message)
			}
		}
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	apiKey := bearerToken(r.Header.Get("Authorization"))
	if apiKey == "" {
		http.Error(w, "missing bearer token", http.StatusUnauthorized)
		return
	}

	// Resolve the instance ID from either a paired device record or a persistent invite.
	var instanceID string

	record, ok := s.cache.getByAPIKey(apiKey)
	if !ok {
		var err error
		record, ok, err = s.store.FindByAPIKey(apiKey)
		if err != nil {
			http.Error(w, "store error", http.StatusInternalServerError)
			return
		}
		if ok {
			s.cache.set(record)
		}
	}
	if ok {
		instanceID = record.InstanceID
	} else {
		// Fallback: the API key may belong to a persistent invite where no phone
		// has paired yet (no device_mappings row exists).
		inv, invOk := s.invites.getByAPIKey(apiKey)
		if !invOk {
			var err error
			inv, invOk, err = s.store.FindInviteByAPIKey(apiKey)
			if err != nil {
				http.Error(w, "store error", http.StatusInternalServerError)
				return
			}
			if invOk {
				s.invites.set(inv)
			}
		}
		if !invOk {
			log.Printf("[ws] rejected connection: invalid token (key=%.8s…)", apiKey)
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		instanceID = inv.InstanceID
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	log.Printf("[ws] client connected instance=%s", instanceID)
	s.hub.Register(instanceID, conn)
	defer func() {
		log.Printf("[ws] client disconnected instance=%s", instanceID)
		s.hub.Remove(instanceID, conn)
		_ = conn.Close()
	}()
	for {
		mt, _, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		if mt == websocket.PingMessage {
			_ = conn.WriteMessage(websocket.PongMessage, []byte("pong"))
		}
	}
}

func (s *Server) routeIncoming(msg webhook.MetaWebhookMessage) {
	from := msg.From
	messageID := msg.ID
	now := time.Now().UTC()

	log.Printf("[route] from=%s type=%s id=%s", maskPhone(from), msg.Type, messageID)
	if msg.Type == "button" && msg.Button != nil {
		log.Printf("[route] button payload=%q text=%q", msg.Button.Payload, msg.Button.Text)
	}
	if msg.Type == "interactive" && msg.Interactive != nil && msg.Interactive.ButtonReply != nil {
		log.Printf("[route] interactive button_reply id=%q title=%q", msg.Interactive.ButtonReply.ID, msg.Interactive.ButtonReply.Title)
	}

	// Pairing codes always arrive as plain text.
	if pairingCodeRegex.MatchString(msg.Text.Body) {
		log.Printf("[route] pairing code detected from=%s", maskPhone(from))

		// Layer 2: global RPM circuit breaker — drop if too many code-format messages.
		if s.bruteForceGlobalDrop(now) {
			log.Printf("[route] brute-force global RPM exceeded, dropping code from=%s", maskPhone(from))
			return
		}

		// Layer 1: per-phone block check.
		if s.bruteForcePhoneBlocked(from, now) {
			log.Printf("[route] brute-force phone blocked from=%s", maskPhone(from))
			return
		}

		// Branch A: try single-use pairing.
		record, err := s.store.ActivatePairing(msg.Text.Body, from, now)
		if err == nil {
			s.cache.set(record)
			log.Printf("[route] single-use pairing activated instance=%s phone=%s", record.InstanceID, maskPhone(record.PhoneNumber))
			_ = s.hub.Send(record.InstanceID, "PAIRING_COMPLETE", messageID, map[string]string{
				"instanceId":  record.InstanceID,
				"phoneNumber": record.PhoneNumber,
				"pairingMode": string(store.ModeSingleUse),
			})
			if _, sendErr := s.waProvider.SendText(context.Background(), from,
				"✅ Pairing complete! Your OpenClaw AI agent is now connected to this WhatsApp number."); sendErr != nil {
				log.Printf("[route] pairing confirm send error: %v", sendErr)
			}
			return
		}

		// Branch B: try persistent invite pairing.
		inv, invOk := s.invites.getByCode(msg.Text.Body)
		if !invOk {
			var storeErr error
			inv, invOk, storeErr = s.store.FindInviteByCode(msg.Text.Body)
			if storeErr != nil {
				log.Printf("[route] FindInviteByCode error: %v", storeErr)
			}
			if invOk {
				s.invites.set(inv)
			}
		}
		if invOk && inv.RevokedAt == nil {
			pairRecord, pairErr := s.store.ActivatePersistentPairing(inv, from, now)
			if pairErr != nil {
				log.Printf("[route] ActivatePersistentPairing error: %v", pairErr)
				if _, sendErr := s.waProvider.SendText(context.Background(), from,
					"❌ Pairing failed. Please try again."); sendErr != nil {
					log.Printf("[route] error reply send error: %v", sendErr)
				}
				return
			}
			s.cache.set(pairRecord)
			log.Printf("[route] persistent pairing activated instance=%s phone=%s invite=%s",
				pairRecord.InstanceID, maskPhone(pairRecord.PhoneNumber), inv.ID)
			_ = s.hub.Send(pairRecord.InstanceID, "PAIRING_COMPLETE", messageID, map[string]string{
				"instanceId":  pairRecord.InstanceID,
				"phoneNumber": pairRecord.PhoneNumber,
				"pairingMode": string(store.ModePersistent),
				"inviteId":    inv.ID,
			})
			if _, sendErr := s.waProvider.SendText(context.Background(), from,
				"✅ Pairing complete! Your OpenClaw AI agent is now connected to this WhatsApp number."); sendErr != nil {
				log.Printf("[route] pairing confirm send error: %v", sendErr)
			}
			return
		}

		// Code matched neither branch — wrong/expired code.
		s.bruteForceRecordWrong(from, now)
		log.Printf("[route] invalid code from=%s err=%v", maskPhone(from), err)
		if _, sendErr := s.waProvider.SendText(context.Background(), from,
			"❌ Invalid or expired pairing code. Please request a new code from your OpenClaw setup wizard and try again."); sendErr != nil {
			log.Printf("[route] invalid code reply error: %v", sendErr)
		}
		return
	}

	record, ok := s.cache.getByPhone(from)
	if !ok {
		var err error
		record, ok, err = s.store.FindByPhone(from)
		if err != nil || !ok {
			log.Printf("[route] no active pairing for from=%s (err=%v ok=%v)", maskPhone(from), err, ok)
			return
		}
		s.cache.set(record)
	}
	if record.Status != store.StatusActive {
		log.Printf("[route] pairing not active for from=%s status=%s id=%s instance=%s api_key=%.8s… updated_at=%s",
			maskPhone(from), record.Status, record.ID, record.InstanceID, record.APIKey, record.UpdatedAt.Format(time.RFC3339))
		return
	}

	// This is a user-initiated inbound — refresh the 24h customer service
	// window. handleSend consults LastInboundAt to decide whether a free-form
	// send is allowed; without this stamp, every message-and-reply cycle would
	// look expired after the first 24h.
	s.cache.updateLastInboundAt(from, now)
	if err := s.store.UpdateLastInboundAt(from, now); err != nil {
		log.Printf("[route] UpdateLastInboundAt failed phone=%s err=%v", maskPhone(from), err)
	}

	// Detect re-engagement template "Read Now" quick-reply tap. The button
	// payload arrives either as msg.Type=="button" (template-attached quick
	// reply) or msg.Type=="interactive" with an interactive.button_reply
	// whose id matches the configured payload. In both cases we suppress
	// the synthetic event from the agent and push WINDOW_OPENED so the
	// plugin can flush its local buffer.
	if s.isReengagementButtonReply(msg) {
		log.Printf("[route] WINDOW_OPENED via button-reply instance=%s phone=%s", record.InstanceID, maskPhone(from))
		_ = s.hub.Send(record.InstanceID, "WINDOW_OPENED", messageID, map[string]string{
			"wab":   record.WabNumber,
			"phone": from,
		})
		return
	}

	log.Printf("[route] dispatching to instance=%s type=%s", record.InstanceID, msg.Type)

	payload := map[string]string{
		"from":      from,
		"messageId": messageID,
		"wab":       record.WabNumber,
	}

	switch msg.Type {
	case "text", "":
		if msg.Text.Body == "" {
			return
		}
		payload["text"] = msg.Text.Body
	case "image":
		if msg.Image == nil || msg.Image.ID == "" {
			return
		}
		payload["mediaId"] = msg.Image.ID
		payload["mediaUrl"] = msg.Image.URL
		payload["mediaType"] = "image"
		payload["mimeType"] = msg.Image.MimeType
		payload["caption"] = msg.Image.Caption
	case "video":
		if msg.Video == nil || msg.Video.ID == "" {
			return
		}
		payload["mediaId"] = msg.Video.ID
		payload["mediaUrl"] = msg.Video.URL
		payload["mediaType"] = "video"
		payload["mimeType"] = msg.Video.MimeType
		payload["caption"] = msg.Video.Caption
	case "audio", "voice":
		media := msg.Audio
		if media == nil || media.ID == "" {
			return
		}
		payload["mediaId"] = media.ID
		payload["mediaUrl"] = media.URL
		payload["mediaType"] = "audio"
		payload["mimeType"] = media.MimeType
	case "sticker":
		if msg.Sticker == nil || msg.Sticker.ID == "" {
			return
		}
		payload["mediaId"] = msg.Sticker.ID
		payload["mediaUrl"] = msg.Sticker.URL
		payload["mediaType"] = "sticker"
		payload["mimeType"] = msg.Sticker.MimeType
	case "document":
		if msg.Document == nil || msg.Document.ID == "" {
			return
		}
		payload["mediaId"] = msg.Document.ID
		payload["mediaUrl"] = msg.Document.URL
		payload["mediaType"] = "document"
		payload["mimeType"] = msg.Document.MimeType
		payload["caption"] = msg.Document.Caption
		payload["fileName"] = msg.Document.Filename
	default:
		return // unsupported type; silently drop
	}

	_ = s.hub.Send(record.InstanceID, "INBOUND_MESSAGE", messageID, payload)
}

// --- Brute-force helpers ---

// bruteForceGlobalDrop returns true and records the event if the global
// code-format message rate exceeds BruteForceGlobalRPM.
func (s *Server) bruteForceGlobalDrop(now time.Time) bool {
	s.bfMu.Lock()
	defer s.bfMu.Unlock()
	oneMinuteAgo := now.Add(-time.Minute)
	recent := make([]time.Time, 0, len(s.bfGlobalEvents)+1)
	for _, t := range s.bfGlobalEvents {
		if t.After(oneMinuteAgo) {
			recent = append(recent, t)
		}
	}
	recent = append(recent, now)
	s.bfGlobalEvents = recent
	return len(recent) > s.cfg.BruteForceGlobalRPM
}

// bruteForcePhoneBlocked returns true if the phone is currently blocked.
func (s *Server) bruteForcePhoneBlocked(phone string, now time.Time) bool {
	s.bfMu.Lock()
	defer s.bfMu.Unlock()
	if unblock, blocked := s.bfPhoneBlocked[phone]; blocked {
		if now.Before(unblock) {
			return true
		}
		// Block expired — clear state.
		delete(s.bfPhoneBlocked, phone)
		delete(s.bfPhoneAttempts, phone)
		delete(s.bfPhoneNotified, phone)
	}
	return false
}

// bruteForceRecordWrong records a wrong attempt for the phone. If the attempt
// count within the configured window reaches BruteForceMaxAttempts, the phone
// is blocked and a single WA notification is sent.
func (s *Server) bruteForceRecordWrong(phone string, now time.Time) {
	s.bfMu.Lock()

	window := time.Duration(s.cfg.BruteForceWindowSeconds) * time.Second
	cutoff := now.Add(-window)
	events := s.bfPhoneAttempts[phone]
	recent := make([]time.Time, 0, len(events)+1)
	for _, t := range events {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	recent = append(recent, now)
	s.bfPhoneAttempts[phone] = recent

	shouldBlock := len(recent) >= s.cfg.BruteForceMaxAttempts
	alreadyNotified := s.bfPhoneNotified[phone]
	blockDuration := time.Duration(s.cfg.BruteForceBlockMinutes) * time.Minute
	if shouldBlock {
		s.bfPhoneBlocked[phone] = now.Add(blockDuration)
		s.bfPhoneAttempts[phone] = nil // reset; will re-accumulate after unblock
	}
	s.bfMu.Unlock()

	if shouldBlock && !alreadyNotified {
		s.bfMu.Lock()
		s.bfPhoneNotified[phone] = true
		s.bfMu.Unlock()
		msg := "⚠️ Too many invalid pairing code attempts. For security, this number has been temporarily blocked. Please try again in " +
			blockDuration.String() + "."
		if _, sendErr := s.waProvider.SendText(context.Background(), phone, msg); sendErr != nil {
			log.Printf("[brute-force] notification send error phone=%s err=%v", maskPhone(phone), sendErr)
		}
	}
}

// --- Helpers ---

// isValidAPIKey checks whether the API key belongs to any active device record
// or any active persistent invite. Used by handlers that only need auth, not routing.
func (s *Server) isValidAPIKey(apiKey string) bool {
	if _, ok := s.cache.getByAPIKey(apiKey); ok {
		return true
	}
	r, ok, err := s.store.FindByAPIKey(apiKey)
	if err == nil && ok {
		s.cache.set(r)
		return r.Status == store.StatusActive
	}
	// Fallback: check persistent invites (instance may not have any paired phones yet).
	if _, ok2 := s.invites.getByAPIKey(apiKey); ok2 {
		return true
	}
	inv, invOk, invErr := s.store.FindInviteByAPIKey(apiKey)
	if invErr == nil && invOk {
		s.invites.set(inv)
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, statusCode int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

// isReengagementButtonReply reports whether msg is the "Read Now" tap on the
// re-engagement template. Matches both Meta's `button` payload (used when a
// quick-reply button is attached to a TEMPLATE message) and the more general
// `interactive.button_reply` shape. Either id/payload string equal to the
// configured ReengagementButtonPayload counts as a hit.
func (s *Server) isReengagementButtonReply(msg webhook.MetaWebhookMessage) bool {
	want := s.cfg.ReengagementButtonPayload
	if want == "" {
		return false
	}
	if msg.Type == "button" && msg.Button != nil && msg.Button.Payload == want {
		return true
	}
	if msg.Type == "interactive" && msg.Interactive != nil &&
		msg.Interactive.Type == "button_reply" && msg.Interactive.ButtonReply != nil &&
		msg.Interactive.ButtonReply.ID == want {
		return true
	}
	return false
}

// maskPhone redacts the middle digits of a phone number for safe logging.
// E.g. "+85296663768" → "+852****3768"
func maskPhone(phone string) string {
	if len(phone) <= 6 {
		return "***"
	}
	return phone[:3] + strings.Repeat("*", len(phone)-6) + phone[len(phone)-3:]
}

// clientIP returns the real client IP, preferring X-Forwarded-For set by Caddy
// over the TCP remote address (which would be the proxy's IP in production).
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i != -1 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i != -1 {
		ip = ip[:i]
	}
	return ip
}

func bearerToken(header string) string {
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, prefix))
}
