package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	HTTPAddr      string
	StoreDriver   string
	StoreFilePath string // path to JSON file when STORE_DRIVER=file
	SharedNumber       string
	WebhookAppSecret   string
	WebhookVerifyToken string
	PairingCodeTTL     time.Duration
	PairRequestPerHour int

	// Brute-force protection
	BruteForceMaxAttempts  int           // wrong code attempts before block (per phone)
	BruteForceBlockMinutes int           // block duration in minutes
	BruteForceWindowSeconds int          // sliding window for attempt counting (seconds)
	BruteForceGlobalRPM    int           // max code-format messages per minute (global)

	// WhatsApp provider selection and credentials.
	// WAProvider selects the outbound delivery backend:
	//   "meta"      — Meta WhatsApp Cloud API (requires WABAToken + WABAPhoneNumberID)
	//   "360dialog" — 360dialog Cloud API     (requires D360APIKey; D360BaseURL optional)
	//   ""          — stub / dev mode (no credentials needed, no real messages sent)
	WAProvider        string
	WABAToken         string
	WABAPhoneNumberID string
	D360APIKey        string
	D360BaseURL       string

	// 24-hour window re-engagement template
	ReengagementTemplateName   string        // template name registered with the provider
	ReengagementTemplateLang   string        // BCP-47 language code, e.g. "en"
	ReengagementButtonPayload  string        // quick-reply payload that triggers WINDOW_OPENED
	TemplateThrottleHours      time.Duration // per-(wab, phone, template) cooldown

	// WindowHours is the client-side 24-hour customer service window enforced
	// before every free-form outbound send. If now - LastInboundAt >= this
	// value, handleSend/handleSendMedia skip the provider call and go straight
	// to the re-engagement template path. Set to 0 to disable the proactive
	// check (falling back to relying on the provider's error signal, which
	// 360dialog does NOT reliably surface — see PR notes). Default 23h leaves
	// a 1h safety margin for clock skew and provider grace periods.
	WindowHours time.Duration
}

func Load() Config {
	return Config{
		HTTPAddr:           getenv("HTTP_ADDR", ":8080"),
		StoreDriver:   getenv("STORE_DRIVER", "sqlite"),
		StoreFilePath: getenv("STORE_FILE_PATH", "./data/store.json"),
		SharedNumber:       getenv("SHARED_WA_NUMBER", "your-whatsapp-number"),
		WebhookAppSecret:   getenv("WEBHOOK_APP_SECRET", "dev-secret"),
		WebhookVerifyToken: getenv("WEBHOOK_VERIFY_TOKEN", ""),
		PairingCodeTTL:     time.Duration(getint("PAIRING_CODE_TTL_SECONDS", 600)) * time.Second,
		PairRequestPerHour: getint("PAIR_RATE_LIMIT_PER_HOUR", 5),
		BruteForceMaxAttempts:   getint("BRUTE_FORCE_MAX_ATTEMPTS", 5),
		BruteForceBlockMinutes:  getint("BRUTE_FORCE_BLOCK_MINUTES", 30),
		BruteForceWindowSeconds: getint("BRUTE_FORCE_WINDOW_SECONDS", 3600),
		BruteForceGlobalRPM:     getint("BRUTE_FORCE_GLOBAL_RPM", 60),
		WAProvider:         getenv("WA_PROVIDER", ""),
		WABAToken:          getenv("WABA_TOKEN", ""),
		WABAPhoneNumberID:  getenv("WABA_PHONE_NUMBER_ID", ""),
		D360APIKey:         getenv("D360_API_KEY", ""),
		D360BaseURL:        getenv("D360_BASE_URL", ""),
		ReengagementTemplateName:  getenv("REENGAGEMENT_TEMPLATE_NAME", "smart_session_20260521"),
		ReengagementTemplateLang:  getenv("REENGAGEMENT_TEMPLATE_LANG", "en"),
		ReengagementButtonPayload: getenv("REENGAGEMENT_BUTTON_PAYLOAD", "OPENCLAW_READ_NOW"),
		TemplateThrottleHours:     time.Duration(getint("TEMPLATE_THROTTLE_HOURS", 24)) * time.Hour,
		WindowHours:               time.Duration(getint("WINDOW_HOURS", 23)) * time.Hour,
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getint(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
