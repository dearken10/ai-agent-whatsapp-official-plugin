package whatsapp

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// metaProvider sends messages via the Meta WhatsApp Cloud API.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages
type metaProvider struct {
	token         string
	phoneNumberID string
	webhookSecret string
}

func newMetaProvider(cfg Config) (*metaProvider, error) {
	if cfg.WABAToken == "" {
		return nil, fmt.Errorf("whatsapp meta provider: WABA_TOKEN is required")
	}
	if cfg.WABAPhoneNumberID == "" {
		return nil, fmt.Errorf("whatsapp meta provider: WABA_PHONE_NUMBER_ID is required")
	}
	return &metaProvider{
		token:         cfg.WABAToken,
		phoneNumberID: cfg.WABAPhoneNumberID,
		webhookSecret: cfg.WebhookAppSecret,
	}, nil
}

// ValidateWebhook verifies the X-Hub-Signature-256 HMAC-SHA256 header using
// the Meta app secret.
func (p *metaProvider) ValidateWebhook(r *http.Request, body []byte) bool {
	header := r.Header.Get("X-Hub-Signature-256")
	if header == "" {
		return false
	}
	parts := strings.SplitN(header, "=", 2)
	if len(parts) != 2 || parts[0] != "sha256" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(p.webhookSecret))
	mac.Write(body)
	received, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	return hmac.Equal(mac.Sum(nil), received)
}

func (p *metaProvider) DownloadMedia(ctx context.Context, mediaID, directURL string) ([]byte, string, error) {
	var downloadURL, resolvedMime string

	if directURL != "" {
		downloadURL = directURL
	} else {
		// Step 1: resolve the temporary download URL from the media ID.
		getURL := "https://graph.facebook.com/v19.0/" + mediaID
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, getURL, nil)
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("Authorization", "Bearer "+p.token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		var meta struct {
			URL      string `json:"url"`
			MimeType string `json:"mime_type"`
		}
		if err = json.NewDecoder(resp.Body).Decode(&meta); err != nil {
			return nil, "", err
		}
		downloadURL = meta.URL
		resolvedMime = meta.MimeType
	}

	// Step 2: download the binary from the resolved URL.
	dlReq, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, "", err
	}
	dlReq.Header.Set("Authorization", "Bearer "+p.token)
	dlResp, err := http.DefaultClient.Do(dlReq)
	if err != nil {
		return nil, "", err
	}
	defer dlResp.Body.Close()
	mimeType := dlResp.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = resolvedMime
	}
	data, err := io.ReadAll(dlResp.Body)
	return data, mimeType, err
}

func (p *metaProvider) SendMedia(ctx context.Context, to, mediaType, mediaURL, caption, filename string) (string, error) {
	url := "https://graph.facebook.com/v19.0/" + p.phoneNumberID + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildMediaPayload(to, mediaType, mediaURL, caption, filename)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)
	return doSend(req)
}

// SendTypingIndicator is not supported by the Meta Cloud API in this way;
// Meta uses separate "mark as read" calls. Return nil (best-effort no-op).
func (p *metaProvider) SendTypingIndicator(_ context.Context, _ string) error { return nil }

func (p *metaProvider) SendText(ctx context.Context, to, text string) (string, error) {
	url := "https://graph.facebook.com/v19.0/" + p.phoneNumberID + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildSendPayload(to, text)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)
	return doSend(req)
}
