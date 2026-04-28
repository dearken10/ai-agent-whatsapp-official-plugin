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
}

func Load() Config {
	return Config{
		HTTPAddr:           getenv("HTTP_ADDR", ":8080"),
		StoreDriver:   getenv("STORE_DRIVER", "memory"),
		StoreFilePath: getenv("STORE_FILE_PATH", "./data/store.json"),
		SharedNumber:       getenv("SHARED_WA_NUMBER", "+18885550100"),
		WebhookAppSecret:   getenv("WEBHOOK_APP_SECRET", "dev-secret"),
		WebhookVerifyToken: getenv("WEBHOOK_VERIFY_TOKEN", ""),
		PairingCodeTTL:     time.Duration(getint("PAIRING_CODE_TTL_SECONDS", 600)) * time.Second,
		PairRequestPerHour: getint("PAIR_RATE_LIMIT_PER_HOUR", 5),
		WAProvider:         getenv("WA_PROVIDER", ""),
		WABAToken:          getenv("WABA_TOKEN", ""),
		WABAPhoneNumberID:  getenv("WABA_PHONE_NUMBER_ID", ""),
		D360APIKey:         getenv("D360_API_KEY", ""),
		D360BaseURL:        getenv("D360_BASE_URL", ""),
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
