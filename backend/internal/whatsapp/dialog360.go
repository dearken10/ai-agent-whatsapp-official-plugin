package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const dialog360DefaultBaseURL = "https://waba-v2.360dialog.io"

// dialog360Provider sends messages via the 360dialog WhatsApp Cloud API.
// It uses the same Cloud API message format as Meta but authenticates with
// the D360-API-KEY header and routes through 360dialog's infrastructure.
//
// Docs: https://docs.360dialog.com/whatsapp-api/whatsapp-api/media
//
// BaseURL options:
//
//	Production:  https://waba-v2.360dialog.io  (default)
//	Sandbox:     https://waba-sandbox.360dialog.io
type dialog360Provider struct {
	apiKey  string
	baseURL string
}

// rewriteMediaURL replaces the host of the Facebook CDN URL returned by 360dialog's
// step-1 media metadata call with the 360dialog base host, keeping the path and query
// intact. This is required by 360dialog: the binary must be fetched through their proxy
// with D360-API-KEY, not directly from the Facebook CDN.
//
// Example:
//
//	https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=...
//	→ https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=...
func rewriteMediaURL(mediaURL, baseURL string) string {
	parsed, err := url.Parse(mediaURL)
	if err != nil {
		return mediaURL
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return mediaURL
	}
	parsed.Scheme = base.Scheme
	parsed.Host = base.Host
	return parsed.String()
}

func newDialog360Provider(cfg Config) (*dialog360Provider, error) {
	if cfg.D360APIKey == "" {
		return nil, fmt.Errorf("whatsapp 360dialog provider: D360_API_KEY is required")
	}
	base := cfg.D360BaseURL
	if base == "" {
		base = dialog360DefaultBaseURL
	}
	return &dialog360Provider{
		apiKey:  cfg.D360APIKey,
		baseURL: strings.TrimRight(base, "/"),
	}, nil
}

// ValidateWebhook accepts all inbound POST requests for the 360dialog provider.
// 360dialog's v2 API does not forward custom headers to the webhook URL, so
// header-based validation is not possible. Security relies on HTTPS and the
// webhook URL not being publicly advertised.
func (p *dialog360Provider) ValidateWebhook(_ *http.Request, _ []byte) bool {
	return true
}

func (p *dialog360Provider) SendTypingIndicator(ctx context.Context, messageID string) error {
	payload, _ := json.Marshal(map[string]interface{}{
		"messaging_product": "whatsapp",
		"status":            "read",
		"message_id":        messageID,
		"typing_indicator":  map[string]string{"type": "text"},
	})
	url := p.baseURL + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("D360-API-KEY", p.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("typing indicator API %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func (p *dialog360Provider) DownloadMedia(ctx context.Context, mediaID, directURL string) ([]byte, string, error) {
	var downloadURL string
	var resolvedMime string

	if directURL != "" {
		// Fast path: webhook already gave us the URL. Rewrite host to 360dialog proxy.
		downloadURL = rewriteMediaURL(directURL, p.baseURL)
	} else {
		// Step 1: resolve the media URL and mime type via the metadata endpoint.
		// 360dialog endpoint: GET /{media-id} (no /media/ prefix)
		// Docs: https://docs.360dialog.com/docs/messaging/media/upload-retrieve-or-delete-media
		metaURL := p.baseURL + "/" + mediaID
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, metaURL, nil)
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("D360-API-KEY", p.apiKey)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			return nil, "", fmt.Errorf("media metadata %d: %s", resp.StatusCode, string(body))
		}
		var meta struct {
			URL      string `json:"url"`
			MimeType string `json:"mime_type"`
		}
		if err = json.NewDecoder(resp.Body).Decode(&meta); err != nil {
			return nil, "", err
		}
		// Step 2: rewrite host to 360dialog proxy
		downloadURL = rewriteMediaURL(meta.URL, p.baseURL)
		resolvedMime = meta.MimeType
	}

	// Download the binary via the 360dialog proxy with API key.
	dlReq, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, "", err
	}
	dlReq.Header.Set("D360-API-KEY", p.apiKey)
	dlResp, err := http.DefaultClient.Do(dlReq)
	if err != nil {
		return nil, "", err
	}
	defer dlResp.Body.Close()
	if dlResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(dlResp.Body)
		return nil, "", fmt.Errorf("media download %d: %s", dlResp.StatusCode, string(body))
	}
	// Use Content-Type from the download response; fall back to step-1 mime type.
	mimeType := dlResp.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = resolvedMime
	}
	data, err := io.ReadAll(dlResp.Body)
	return data, mimeType, err
}

func (p *dialog360Provider) SendMedia(ctx context.Context, to, mediaType, mediaURL, caption, filename string) (string, error) {
	url := p.baseURL + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildMediaPayload(to, mediaType, mediaURL, caption, filename)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("D360-API-KEY", p.apiKey)
	return doSend(req)
}

func (p *dialog360Provider) SendText(ctx context.Context, to, text string) (string, error) {
	url := p.baseURL + "/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buildSendPayload(to, text)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("D360-API-KEY", p.apiKey)
	return doSend(req)
}
