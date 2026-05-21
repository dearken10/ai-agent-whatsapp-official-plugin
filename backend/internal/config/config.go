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
