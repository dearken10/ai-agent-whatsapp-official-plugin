SHELL := /bin/bash

.PHONY: up down smoke pair ws send test ngrok publish-plugin-local publish-plugin-npm-clawhub aws-login deploy deploy-update

up:
	./scripts/dev-up.sh

down:
	./scripts/dev-down.sh

smoke:
	./scripts/smoke-test.sh

pair:
	cd backend && go run ./cmd/devcli pair

ws:
	@echo "Usage: make ws API_KEY=imbee_xxx"
	cd backend && go run ./cmd/devcli ws --api-key "$(API_KEY)"

send:
	@echo "Usage: make send API_KEY=imbee_xxx TEXT='hello'"
	cd backend && go run ./cmd/devcli send --api-key "$(API_KEY)" --text "$(TEXT)"

test:
	cd backend && go test ./...

ngrok:
	./scripts/ngrok-up.sh

# Default env file for deploy/publish targets. Override with ENV_FILE=.env.prod
ENV_FILE ?= .env.dev

# Patch ROUTING_BASE_URL into plugin source for local dev (no publish).
# Defaults to .env so the local ngrok/localhost URL is used.
#   make publish-plugin-local
#   make publish-plugin-local BAKE_ENV_FILE=.env.dev
BAKE_ENV_FILE ?= .env
publish-plugin-local:
	./scripts/publish-plugin-local.sh --env-file "$(BAKE_ENV_FILE)"

publish-plugin-npm-clawhub:
	./scripts/publish-plugin-npm-clawhub.sh --env-file "$(ENV_FILE)"

# ── AWS deployment ────────────────────────────────────────────────────────────
# Authenticate with AWS SSO (opens browser on first run / after expiry).
# Reads AWS_PROD_PROFILE / AWS_DEV_PROFILE / AWS_SSO_START_URL / AWS_SSO_REGION
# from .env. See .env.example for the variables you need to set.
# NOTE: make runs targets in subshells, so AWS_PROFILE cannot be exported back
# to your terminal. Use eval in your shell instead:
#   eval "$(./scripts/aws-login.sh)"        # prod
#   eval "$(./scripts/aws-login.sh --dev)"  # dev
# Or pass PROFILE= explicitly to deploy targets (see below).
aws-login:
	./scripts/aws-login.sh $(if $(DEV),--dev,)

# Deploy (or redeploy) the routing backend to EC2.
# Requires DOMAIN. Pass PROFILE if AWS_PROFILE is not set in your shell.
#
#   eval "$(./scripts/aws-login.sh --dev)"
#   make deploy DOMAIN=api.example.com
#
#   # or without eval, pass PROFILE explicitly:
#   make deploy DOMAIN=api.example.com PROFILE=<account-id>_AdministratorAccess
deploy:
	@[ -n "$(DOMAIN)" ] || (echo "ERROR: DOMAIN is required.  make deploy DOMAIN=api.example.com" && exit 1)
	./scripts/deploy-aws.sh --domain "$(DOMAIN)" --env-file "$(ENV_FILE)" \
		$(if $(PROFILE),--profile "$(PROFILE)",) \
		$(if $(INSTANCE_TYPE),--instance-type "$(INSTANCE_TYPE)",)

# Push updated binary + config to existing instance (skips infra creation).
#   make deploy-update DOMAIN=api.example.com
#   make deploy-update DOMAIN=api.example.com ENV_FILE=.env.prod
deploy-update:
	@[ -n "$(DOMAIN)" ] || (echo "ERROR: DOMAIN is required.  make deploy-update DOMAIN=api.example.com" && exit 1)
	./scripts/deploy-aws.sh --domain "$(DOMAIN)" --update --env-file "$(ENV_FILE)" \
		$(if $(PROFILE),--profile "$(PROFILE)",)
