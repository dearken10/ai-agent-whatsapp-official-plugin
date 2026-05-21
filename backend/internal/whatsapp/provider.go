// Package whatsapp defines the Provider interface for outbound WhatsApp message
// delivery and contains the factory that selects the active implementation.
//
// Adding a new provider:
//  1. Create a new file (e.g. twilio.go) in this package.
//  2. Implement the Provider interface.
//  3. Add a case to New() below.
//  4. Add the provider-specific fields to Config.
package whatsapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// Provider delivers outbound WhatsApp messages, downloads inbound media, and
// validates inbound webhook requests. All implementations must be safe for
// concurrent use.
type Provider interface {
	SendText(ctx context.Context, to, text string) (messageID string, err error)

	// SendMedia sends an image, video, audio, or document message.
	// mediaType must be one of: "image", "video", "audio", "document".
	// mediaURL must be a publicly reachable HTTPS URL.
	// caption and filename are optional (filename is only used for documents).
	SendMedia(ctx context.Context, to, mediaType, mediaURL, caption, filename string) (messageID string, err error)

	// DownloadMedia fetches the raw bytes and MIME type for a received media
	// object. mediaID is the provider-specific identifier. directURL, if
	// non-empty, is the pre-resolved download URL from the webhook payload and
	// skips the step-1 metadata lookup (faster, avoids an extra round-trip).
	DownloadMedia(ctx context.Context, mediaID, directURL string) (data []byte, mimeType string, err error)

	// SendTypingIndicator marks the given inbound message as read and shows
	// a typing indicator to the sender. It is best-effort; callers may ignore
	// the returned error.
	SendTypingIndicator(ctx context.Context, messageID string) error

	// ValidateWebhook reports whether the inbound webhook request is authentic.
	// body is the raw (already-read) request body. Each provider uses its own
	// authentication mechanism (HMAC, header token, etc.).
	// Returning true with no secret configured (stub mode) skips all checks.
	ValidateWebhook(r *http.Request, body []byte) bool
}

// Config holds credentials for all supported providers.
// Only the fields relevant to the active Provider need to be populated.
type Config struct {
	// Provider selects the backend.
	// Valid values: "meta", "360dialog"
	// Empty string / "stub" activates dev mode (no network calls).
	Provider string

	// Meta Cloud API
	WABAToken          string
	WABAPhoneNumberID  string
	WebhookAppSecret   string // HMAC secret from Meta App Dashboard

	// 360dialog
	// WebhookSecret is automatically derived from D360APIKey (360dialog signs
	// webhooks with the client API key — no separate secret needed).
	D360APIKey  string
	D360BaseURL string // optional; defaults to https://waba-v2.360dialog.io
}

// New constructs the Provider named by cfg.Provider.
// An unrecognised name returns an error so misconfiguration is caught at
// startup rather than silently at first send.
func New(cfg Config) (Provider, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "stub", "dev":
		return &stubProvider{}, nil
	case "meta":
		return newMetaProvider(cfg)
	case "360dialog":
		return newDialog360Provider(cfg)
	default:
		return nil, fmt.Errorf("unknown whatsapp provider %q; valid values: meta, 360dialog", cfg.Provider)
	}
}

// -------------------------------------------------------------------------
// Shared request / response types (same shape across all Cloud API providers)
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Shared media payload types (Cloud API format used by all providers)
// -------------------------------------------------------------------------

type sendMediaPayload struct {
	MessagingProduct string    `json:"messaging_product"`
	RecipientType    string    `json:"recipient_type"`
	To               string    `json:"to"`
	Type             string    `json:"type"`
	Image            *mediaLink `json:"image,omitempty"`
	Video            *mediaLink `json:"video,omitempty"`
	Audio            *mediaLink `json:"audio,omitempty"`
	Document         *docLink   `json:"document,omitempty"`
}

type mediaLink struct {
	Link    string `json:"link"`
	Caption string `json:"caption,omitempty"`
}

type docLink struct {
	Link     string `json:"link"`
	Caption  string `json:"caption,omitempty"`
	Filename string `json:"filename,omitempty"`
}

// buildMediaPayload encodes the standard WhatsApp media message body.
func buildMediaPayload(to, mediaType, mediaURL, caption, filename string) []byte {
	p := sendMediaPayload{
		MessagingProduct: "whatsapp",
		RecipientType:    "individual",
		To:               to,
		Type:             mediaType,
	}
	switch mediaType {
	case "document":
		p.Document = &docLink{Link: mediaURL, Caption: caption, Filename: filename}
	case "image":
		p.Image = &mediaLink{Link: mediaURL, Caption: caption}
	case "video":
		p.Video = &mediaLink{Link: mediaURL, Caption: caption}
	case "audio":
		p.Audio = &mediaLink{Link: mediaURL}
	}
	b, _ := json.Marshal(p)
	return b
}

type sendTextPayload struct {
	MessagingProduct string        `json:"messaging_product"`
	RecipientType    string        `json:"recipient_type"`
	To               string        `json:"to"`
	Type             string        `json:"type"`
	Text             sendTextBody  `json:"text"`
}

type sendTextBody struct {
	PreviewURL bool   `json:"preview_url"`
	Body       string `json:"body"`
}

type sendResponse struct {
	Messages []struct {
		ID string `json:"id"`
	} `json:"messages"`
}

// buildSendPayload encodes the standard WhatsApp text message body shared by
// all providers that speak the Cloud API message format.
func buildSendPayload(to, text string) []byte {
	b, _ := json.Marshal(sendTextPayload{
		MessagingProduct: "whatsapp",
		RecipientType:    "individual",
		To:               to,
		Type:             "text",
		Text:             sendTextBody{PreviewURL: false, Body: text},
	})
	return b
}

// doSend executes req, checks the HTTP status, and extracts the wamid.
// req must already have Content-Type and auth headers set.
func doSend(req *http.Request) (string, error) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("provider API %d: %s", resp.StatusCode, string(body))
	}

	var result sendResponse
	if err = json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Messages) == 0 {
		return "", fmt.Errorf("provider API returned no message IDs")
	}
	return result.Messages[0].ID, nil
}

// -------------------------------------------------------------------------
// Stub provider (dev / no-credentials mode)
// -------------------------------------------------------------------------

type stubProvider struct{}

func (s *stubProvider) SendText(_ context.Context, _, _ string) (string, error) {
	return "wamid." + uuid.NewString(), nil
}

func (s *stubProvider) SendMedia(_ context.Context, _, _, _, _, _ string) (string, error) {
	return "wamid." + uuid.NewString(), nil
}

func (s *stubProvider) DownloadMedia(_ context.Context, _, _ string) ([]byte, string, error) {
	return []byte("stub-media"), "application/octet-stream", nil
}

func (s *stubProvider) SendTypingIndicator(_ context.Context, _ string) error { return nil }

func (s *stubProvider) ValidateWebhook(_ *http.Request, _ []byte) bool { return true }
