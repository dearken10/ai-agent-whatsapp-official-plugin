#!/usr/bin/env bash
# deploy-aws.sh — Deploy the routing backend to a single AWS EC2 instance.
#
# What it does:
#   1. Cross-compiles the Go binary for linux/arm64
#   2. Creates (or reuses) a key pair, security group, and t4g.nano instance
#   3. Uploads the binary, .env, and a systemd unit via SCP
#   4. Installs Caddy for automatic HTTPS (Let's Encrypt)
#   5. Starts/restarts the wa-server systemd service
#
# Prerequisites:
#   aws CLI (configured with credentials), go >= 1.21, ssh, scp
#
# Usage:
#   eval "$(./scripts/aws-login.sh)"          # authenticate first (SSO)
#   ./scripts/deploy-aws.sh --domain api.example.com
#   ./scripts/deploy-aws.sh --domain api.example.com --region ap-east-1 --instance-type t4g.small
#
# After first deploy, point your domain's A record at the printed IP address,
# then run this script again (or wait for Caddy to obtain the TLS certificate
# once DNS propagates). Then set ROUTING_BASE_URL in .env and run this script
# again to push the updated config.
#
# Environment / flags:
#   --domain          FQDN for the server (required; Meta webhooks need HTTPS)
#   --profile         AWS CLI profile             (default: AWS_PROFILE env var or default)
#   --region          AWS region                  (default: AWS_DEFAULT_REGION or us-east-1)
#   --instance-type   EC2 instance type           (default: t4g.nano)
#   --key-name        EC2 key pair name           (default: openclaw-wa)
#   --sg-name         Security group name         (default: openclaw-wa-sg)
#   --tag             EC2 Name tag                (default: openclaw-wa-backend)
#   --update          Only push binary/config to existing instance, skip infra
set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "[deploy] $*"; }
err()  { echo "[deploy] ERROR: $*" >&2; exit 1; }
need() { command -v "$1" &>/dev/null || err "'$1' is not installed or not on PATH"; }

# ── Defaults / flags ─────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOMAIN="${DOMAIN:-}"
PROFILE="${AWS_PROFILE:-}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.nano}"
KEY_NAME="${KEY_NAME:-openclaw-wa}"
SG_NAME="${SG_NAME:-openclaw-wa-sg}"
TAG_NAME="${TAG_NAME:-openclaw-wa-backend}"
UPDATE_ONLY=false
ENV_FILE="$REPO_ROOT/.env.dev"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        DOMAIN="$2";        shift 2 ;;
    --profile)       PROFILE="$2";       shift 2 ;;
    --region)        REGION="$2";        shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --key-name)      KEY_NAME="$2";      shift 2 ;;
    --sg-name)       SG_NAME="$2";       shift 2 ;;
    --tag)           TAG_NAME="$2";      shift 2 ;;
    --update)        UPDATE_ONLY=true;   shift   ;;
    --env-file)      ENV_FILE="$2";      shift 2 ;;
    *) err "Unknown argument: $1" ;;
  esac
done

# ── Load env file ─────────────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  err "Env file not found: $ENV_FILE (use --env-file to specify a different path)"
fi

[[ -n "$DOMAIN" ]] || err "--domain is required (e.g. --domain api.example.com)"

KEY_FILE="$HOME/.ssh/${KEY_NAME}.pem"

# Build the base AWS command (with optional profile)
AWS="aws --region $REGION"
if [[ -n "$PROFILE" ]]; then
  AWS="aws --region $REGION --profile $PROFILE"
  export AWS_PROFILE="$PROFILE"
fi

# ── Prerequisites ─────────────────────────────────────────────────────────────

need aws
need go
need ssh
need scp

IDENTITY=$($AWS sts get-caller-identity --output text 2>&1) \
  || err "AWS authentication failed. Run:  eval \"\$(./scripts/aws-login.sh)\"  then retry."
log "Authenticated: $(echo "$IDENTITY" | awk '{print $NF}')"

# ── Build binary (linux/arm64 for Graviton) ───────────────────────────────────

BINARY="/tmp/wa-server-linux-arm64"
log "Building linux/arm64 binary → $BINARY"
(cd "$REPO_ROOT/backend" && \
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o "$BINARY" ./cmd/server)
log "Binary size: $(du -sh "$BINARY" | cut -f1)"

if $UPDATE_ONLY; then
  # ── Update-only path: find existing instance and push ────────────────────
  INSTANCE_ID=$($AWS ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG_NAME" "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].InstanceId" --output text)
  [[ "$INSTANCE_ID" != "None" && -n "$INSTANCE_ID" ]] \
    || err "No running instance tagged '$TAG_NAME' found. Run without --update to create one."
  PUBLIC_IP=$($AWS ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
  log "Updating existing instance $INSTANCE_ID ($PUBLIC_IP)"
else
  # ── Infrastructure ────────────────────────────────────────────────────────

  # Key pair
  if [[ ! -f "$KEY_FILE" ]]; then
    existing=$($AWS ec2 describe-key-pairs \
      --filters "Name=key-name,Values=$KEY_NAME" \
      --query "KeyPairs[0].KeyName" --output text 2>/dev/null || true)
    if [[ "$existing" == "$KEY_NAME" ]]; then
      err "Key pair '$KEY_NAME' already exists in AWS but $KEY_FILE is missing locally. " \
          "Delete the key pair in the console and re-run, or copy the .pem file to $KEY_FILE"
    fi
    log "Creating key pair '$KEY_NAME'"
    $AWS ec2 create-key-pair \
      --key-name "$KEY_NAME" \
      --query "KeyMaterial" \
      --output text > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    log "Private key saved to $KEY_FILE"
  else
    log "Key pair '$KEY_NAME' already exists locally ($KEY_FILE)"
  fi

  # Security group
  SG_ID=$($AWS ec2 describe-security-groups \
    --filters "Name=group-name,Values=$SG_NAME" \
    --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || true)
  if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
    log "Creating security group '$SG_NAME'"
    SG_ID=$($AWS ec2 create-security-group \
      --group-name "$SG_NAME" \
      --description "openclaw whatsapp backend" \
      --query "GroupId" --output text)
    $AWS ec2 authorize-security-group-ingress --group-id "$SG_ID" \
      --ip-permissions \
        "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0}]" \
        "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]" \
        "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]" \
        "IpProtocol=tcp,FromPort=443,ToPort=443,Ipv6Ranges=[{CidrIpv6=::/0}]"
    log "Security group created: $SG_ID (ports 22, 80, 443)"
  else
    log "Reusing security group $SG_ID"
  fi

  # EC2 instance — check if one already exists
  INSTANCE_ID=$($AWS ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG_NAME" "Name=instance-state-name,Values=running,pending,stopped" \
    --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null || true)

  if [[ "$INSTANCE_ID" == "None" || -z "$INSTANCE_ID" ]]; then
    # Resolve the latest Amazon Linux 2023 arm64 AMI
    AMI_ID=$($AWS ec2 describe-images \
      --owners amazon \
      --filters \
        "Name=name,Values=al2023-ami-minimal-*" \
        "Name=architecture,Values=arm64" \
        "Name=state,Values=available" \
      --query "sort_by(Images, &CreationDate)[-1].ImageId" \
      --output text)
    [[ -n "$AMI_ID" && "$AMI_ID" != "None" ]] || err "Could not find Amazon Linux 2023 arm64 AMI in region $REGION"
    log "Using AMI $AMI_ID (Amazon Linux 2023 arm64)"

    log "Launching $INSTANCE_TYPE instance..."
    INSTANCE_ID=$($AWS ec2 run-instances \
      --image-id "$AMI_ID" \
      --instance-type "$INSTANCE_TYPE" \
      --key-name "$KEY_NAME" \
      --security-groups "$SG_NAME" \
      --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,DeleteOnTermination=true}" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG_NAME}]" \
      --query "Instances[0].InstanceId" \
      --output text)
    log "Instance $INSTANCE_ID launched"
  else
    log "Reusing existing instance $INSTANCE_ID"
    # Start it if stopped
    STATE=$($AWS ec2 describe-instances --instance-ids "$INSTANCE_ID" \
      --query "Reservations[0].Instances[0].State.Name" --output text)
    if [[ "$STATE" == "stopped" ]]; then
      log "Starting stopped instance..."
      $AWS ec2 start-instances --instance-ids "$INSTANCE_ID" > /dev/null
    fi
  fi

  # Wait for running + public IP
  log "Waiting for instance to be running..."
  $AWS ec2 wait instance-running --instance-ids "$INSTANCE_ID"

  PUBLIC_IP=$($AWS ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
  log "Instance running at $PUBLIC_IP"
fi

# ── Wait for SSH ──────────────────────────────────────────────────────────────

SSH_OPTS="-i $KEY_FILE -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"
REMOTE="ec2-user@$PUBLIC_IP"

log "Waiting for SSH to become available..."
for i in $(seq 1 24); do
  if ssh $SSH_OPTS "$REMOTE" "true" 2>/dev/null; then
    break
  fi
  [[ $i -lt 24 ]] || err "SSH did not become available after 2 minutes"
  sleep 5
done
log "SSH ready"

# ── Build server .env for remote ──────────────────────────────────────────────
# Strip comment lines, blank lines, and override a few values for production.

REMOTE_ENV=$(mktemp)
trap 'rm -f "$REMOTE_ENV"' EXIT

{
  grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' || true
  # Ensure file store path uses an absolute path on the remote host
  echo "STORE_DRIVER=file"
  echo "STORE_FILE_PATH=/home/ec2-user/data/store.json"
  # Point the routing server at itself
  echo "ROUTING_BASE_URL=https://$DOMAIN"
  echo "HTTP_ADDR=:8080"
} | sort -u -t= -k1,1 > "$REMOTE_ENV"   # last value for each key wins (sort -u on key)

# ── Upload files ──────────────────────────────────────────────────────────────

log "Uploading binary and config..."
# Stop the service first so the binary file is not locked during upload
ssh $SSH_OPTS "$REMOTE" "sudo systemctl stop wa-server 2>/dev/null || true"
scp $SSH_OPTS "$BINARY" "$REMOTE":/home/ec2-user/wa-server
scp $SSH_OPTS "$REMOTE_ENV" "$REMOTE":/home/ec2-user/.env

# ── Remote provisioning ───────────────────────────────────────────────────────

log "Provisioning remote host..."
# shellcheck disable=SC2087
ssh $SSH_OPTS "$REMOTE" bash -s << ENDSSH
set -euo pipefail

# ── Caddy ────────────────────────────────────────────────────────────────────
if ! command -v caddy &>/dev/null; then
  echo "[remote] Installing Caddy..."
  sudo dnf install -y 'dnf-command(copr)' 2>/dev/null || true
  # Caddy is available in the Fedora COPR repo; fallback: install binary directly
  CADDY_VER=\$(curl -sL https://api.github.com/repos/caddyserver/caddy/releases/latest \
    | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
  curl -sL "https://github.com/caddyserver/caddy/releases/download/v\${CADDY_VER}/caddy_\${CADDY_VER}_linux_arm64.tar.gz" \
    | sudo tar -xz -C /usr/local/bin caddy
  sudo chmod +x /usr/local/bin/caddy
  sudo setcap cap_net_bind_service=+ep /usr/local/bin/caddy
fi

# ── Caddyfile ────────────────────────────────────────────────────────────────
sudo mkdir -p /etc/caddy
sudo tee /etc/caddy/Caddyfile > /dev/null << CADDY
$DOMAIN {
    reverse_proxy localhost:8080
}
CADDY

# ── Caddy systemd service ────────────────────────────────────────────────────
if ! systemctl is-enabled caddy &>/dev/null 2>&1; then
  sudo tee /etc/systemd/system/caddy.service > /dev/null << 'SVC'
[Unit]
Description=Caddy web server
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStartPre=/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
SVC
  sudo useradd --system --home /var/lib/caddy --shell /sbin/nologin caddy 2>/dev/null || true
  sudo mkdir -p /var/lib/caddy
  sudo chown caddy:caddy /var/lib/caddy
  sudo systemctl daemon-reload
  sudo systemctl enable caddy
fi

# ── wa-server binary + data dir ──────────────────────────────────────────────
chmod +x /home/ec2-user/wa-server
mkdir -p /home/ec2-user/data

# ── wa-server systemd service ────────────────────────────────────────────────
sudo tee /etc/systemd/system/wa-server.service > /dev/null << 'SVC'
[Unit]
Description=OpenClaw WhatsApp routing server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user
EnvironmentFile=/home/ec2-user/.env
ExecStart=/home/ec2-user/wa-server
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVC

sudo systemctl daemon-reload
sudo systemctl enable wa-server

# ── (Re)start services ───────────────────────────────────────────────────────
sudo systemctl restart wa-server
sleep 1
sudo systemctl restart caddy 2>/dev/null || sudo systemctl start caddy

echo "[remote] Done"
ENDSSH

# ── Health check ─────────────────────────────────────────────────────────────

log "Checking health endpoint (HTTP, before DNS/TLS)..."
if curl -sf --max-time 5 "http://$PUBLIC_IP:8080/healthz" > /dev/null 2>&1; then
  log "Health check passed (backend is up)"
else
  log "Health check on :8080 did not respond yet — this is normal if the service is still starting"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

cat <<SUMMARY

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Deploy complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Instance:   $INSTANCE_ID  ($INSTANCE_TYPE)
  Public IP:  $PUBLIC_IP
  Domain:     $DOMAIN
  SSH:        ssh -i $KEY_FILE ec2-user@$PUBLIC_IP
  Logs:       ssh -i $KEY_FILE ec2-user@$PUBLIC_IP 'journalctl -u wa-server -f'

  Next steps
  ──────────
  1. Point your DNS A record:
       $DOMAIN  →  $PUBLIC_IP

  2. Once DNS propagates, Caddy will auto-obtain a TLS certificate.
     Verify HTTPS:
       curl https://$DOMAIN/healthz

  3. Register the webhook URL in your WhatsApp provider:
       Webhook URL:  https://$DOMAIN/webhooks/whatsapp
       Verify token: (value of WEBHOOK_VERIFY_TOKEN in .env)

  4. Update ROUTING_BASE_URL in .env to:
       ROUTING_BASE_URL=https://$DOMAIN
     then run this script again (or just:
       scp -i $KEY_FILE .env ec2-user@$PUBLIC_IP:.env
       ssh -i $KEY_FILE ec2-user@$PUBLIC_IP 'sudo systemctl restart wa-server'
     )
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
