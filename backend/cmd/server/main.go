package main

import (
	"log"
	nethttp "net/http"

	apphttp "github.com/imbee/openclaw-whatsapp-official/backend/internal/http"
	"github.com/imbee/openclaw-whatsapp-official/backend/internal/config"
)

func main() {
	cfg := config.Load()

	// Warn loudly if running with insecure defaults in a real provider context.
	if cfg.WAProvider != "" && cfg.WebhookAppSecret == "dev-secret" {
		log.Fatal("FATAL: WEBHOOK_APP_SECRET is set to the insecure default 'dev-secret'. Set a random secret before starting.")
	}
	if cfg.WAProvider != "" && cfg.WebhookVerifyToken == "" {
		log.Fatal("FATAL: WEBHOOK_VERIFY_TOKEN is not set. Configure it to protect the webhook registration endpoint.")
	}

	server, err := apphttp.NewServer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer server.Close()

	log.Printf("routing server listening on %s", cfg.HTTPAddr)
	if err = nethttp.ListenAndServe(cfg.HTTPAddr, server.Router()); err != nil {
		log.Fatal(err)
	}
}
