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
	"mime/multipart"
	"net/http"
	"net/textproto"
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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildMediaPayload(to, mediaType, mediaURL, "", caption, filename)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)
	return doSend(req)
}

// SendFileMedia uploads raw bytes to Meta's media endpoint, then sends a
// message referencing the returned media id. Avoids needing a public URL.
func (p *metaProvider) SendFileMedia(ctx context.Context, to, mediaType, mimeType, filename string, data []byte, caption string) (string, error) {
	mediaID, err := p.uploadMedia(ctx, mediaType, mimeType, filename, data)
	if err != nil {
		return "", fmt.Errorf("media upload: %w", err)
	}
	url := "https://graph.facebook.com/v19.0/" + p.phoneNumberID + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildMediaPayload(to, mediaType, "", mediaID, caption, filename)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)
	return doSend(req)
}

// uploadMedia POSTs raw bytes to Meta's /PHONE_ID/media endpoint and returns
// the media id. The id is valid for 30 days and can be used in subsequent
// message sends.
func (p *metaProvider) uploadMedia(ctx context.Context, mediaType, mimeType, filename string, data []byte) (string, error) {
	uploadURL := "https://graph.facebook.com/v19.0/" + p.phoneNumberID + "/media"

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("messaging_product", "whatsapp")
	_ = mw.WriteField("type", mimeType)

	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	if mimeType != "" {
		h.Set("Content-Type", mimeType)
	}
	fw, err := mw.CreatePart(h)
	if err != nil {
		return "", err
	}
	if _, err = fw.Write(data); err != nil {
		return "", err
	}
	if err = mw.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+p.token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("meta media upload %d: %s", resp.StatusCode, string(b))
	}
	var out struct {
		ID string `json:"id"`
	}
	if err = json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("meta media upload: empty id in response")
	}
	return out.ID, nil
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

func (p *metaProvider) SendTemplate(ctx context.Context, to, name, lang string, components []TemplateComponent) (string, error) {
	url := "https://graph.facebook.com/v19.0/" + p.phoneNumberID + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildTemplatePayload(to, name, lang, components)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)
	return doSend(req)
}
