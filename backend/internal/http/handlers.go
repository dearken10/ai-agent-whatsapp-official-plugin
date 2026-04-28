package http

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
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
	waProvider whatsapp.Provider
	upgrader   websocket.Upgrader
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
		Provider:         cfg.WAProvider,
		WABAToken:        cfg.WABAToken,
		WABAPhoneNumberID: cfg.WABAPhoneNumberID,
		WebhookAppSecret: cfg.WebhookAppSecret,
		D360APIKey:       cfg.D360APIKey,
		D360BaseURL:      cfg.D360BaseURL,
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
		cfg:        cfg,
		store:      st,
		pairingSvc: pairing.NewService(cfg, st),
		hub:        ws.NewHub(),
		cache:      newRecordCache(),
		waProvider: waProvider,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}, nil
}

func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/healthz", s.handleHealth).Methods(http.MethodGet)
	r.HandleFunc("/api/v1/pair/request", s.handlePairRequest).Methods(http.MethodPost)
	r.HandleFunc("/api/v1/pair/status", s.handlePairStatus).Methods(http.MethodGet)
	r.HandleFunc("/api/v1/send", s.handleSend).Methods(http.MethodPost)
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
	record, err := s.pairingSvc.CreatePairing(clientIP(r))
	if err != nil {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"instanceId":  record.InstanceID,
		"pairingCode": record.PairingCode,
		"expiresAt":   record.ExpiresAt.Format(time.RFC3339),
		"waMeUrl":     pairing.WaMeURL(s.cfg.SharedNumber, record.PairingCode),
		"apiKey":      record.APIKey,
		"wabNumber":   record.WabNumber,
	})
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
	if !ok || record.Status != store.StatusActive {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "inactive or invalid token"})
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
	if req.ToPhoneNumber != record.PhoneNumber {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "target mismatch: can only send to paired number"})
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
	if !ok || record.Status != store.StatusActive {
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
	_, ok := s.cache.getByAPIKey(apiKey)
	if !ok {
		var err error
		_, ok, err = s.store.FindByAPIKey(apiKey)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store error"})
			return
		}
	}
	if !ok {
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
// Meta sends hub.mode=subscribe, hub.verify_token, and hub.challenge; we echo the challenge back.
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
	if !ok {
		log.Printf("[ws] rejected connection: invalid token (key=%.8s…)", apiKey)
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	log.Printf("[ws] client connected instance=%s status=%s", record.InstanceID, record.Status)
	s.hub.Register(record.InstanceID, conn)
	defer func() {
		log.Printf("[ws] client disconnected instance=%s", record.InstanceID)
		s.hub.Remove(record.InstanceID, conn)
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

	// Pairing codes always arrive as plain text.
	if pairingCodeRegex.MatchString(msg.Text.Body) {
		log.Printf("[route] pairing code detected from=%s", maskPhone(from))
		record, err := s.store.ActivatePairing(msg.Text.Body, from, now)
		if err != nil {
			log.Printf("[route] ActivatePairing error: %v", err)
			if _, sendErr := s.waProvider.SendText(context.Background(), from,
				"❌ Invalid or expired pairing code. Please request a new code from your OpenClaw setup wizard and try again."); sendErr != nil {
				log.Printf("[route] invalid code reply error: %v", sendErr)
			}
			return
		}
		s.cache.set(record)
		log.Printf("[route] pairing activated instance=%s phone=%s", record.InstanceID, maskPhone(record.PhoneNumber))
		_ = s.hub.Send(record.InstanceID, "PAIRING_COMPLETE", messageID, map[string]string{
			"instanceId":  record.InstanceID,
			"phoneNumber": record.PhoneNumber,
		})
		// Confirm to the user via WhatsApp
		if _, sendErr := s.waProvider.SendText(context.Background(), from, "✅ Pairing complete! Your OpenClaw AI agent is now connected to this WhatsApp number."); sendErr != nil {
			log.Printf("[route] pairing confirm send error: %v", sendErr)
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
		log.Printf("[route] pairing not active for from=%s status=%s", maskPhone(from), record.Status)
		return
	}
	log.Printf("[route] dispatching to instance=%s type=%s", record.InstanceID, msg.Type)

	payload := map[string]string{
		"from":      from,
		"messageId": messageID,
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


func writeJSON(w http.ResponseWriter, statusCode int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
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
		// X-Forwarded-For may be a comma-separated list; take the first entry.
		if i := strings.Index(xff, ","); i != -1 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	// Fall back to RemoteAddr, stripping the port.
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
