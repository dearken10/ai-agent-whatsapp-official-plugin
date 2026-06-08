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

// ButtonObject is the payload Meta sends when the user taps a quick-reply
// button in a *template* message (message.type == "button").
type ButtonObject struct {
	Payload string `json:"payload"`
	Text    string `json:"text"`
}

// InteractiveObject is the payload Meta sends when the user taps a button or
// list item in an *interactive* message (message.type == "interactive").
// For button replies, the payload is the button id chosen by the template.
type InteractiveObject struct {
	Type        string `json:"type"`
	ButtonReply *struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"button_reply,omitempty"`
	ListReply *struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"list_reply,omitempty"`
}

type MetaWebhookMessage struct {
	From     string          `json:"from"`
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Text     struct {
		Body string `json:"body"`
	} `json:"text"`
	Image       *MediaObject       `json:"image"`
	Video       *MediaObject       `json:"video"`
	Audio       *MediaObject       `json:"audio"`
	Sticker     *MediaObject       `json:"sticker"`
	Document    *DocumentObject    `json:"document"`
	Button      *ButtonObject      `json:"button"`
	Interactive *InteractiveObject `json:"interactive"`
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
