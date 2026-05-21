package webhook

type MediaObject struct {
	MimeType string `json:"mime_type"`
	SHA256   string `json:"sha256"`
	ID       string `json:"id"`
	URL      string `json:"url"`
	Caption  string `json:"caption"`
}

type DocumentObject struct {
	MimeType string `json:"mime_type"`
	SHA256   string `json:"sha256"`
	ID       string `json:"id"`
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Caption  string `json:"caption"`
}

type MetaWebhookMessage struct {
	From     string          `json:"from"`
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Text     struct {
		Body string `json:"body"`
	} `json:"text"`
	Image    *MediaObject    `json:"image"`
	Video    *MediaObject    `json:"video"`
	Audio    *MediaObject    `json:"audio"`
	Sticker  *MediaObject    `json:"sticker"`
	Document *DocumentObject `json:"document"`
}

type MetaWebhookPayload struct {
	Entry []struct {
		Changes []struct {
			Value struct {
				Messages []MetaWebhookMessage `json:"messages"`
			} `json:"value"`
		} `json:"changes"`
	} `json:"entry"`
}
