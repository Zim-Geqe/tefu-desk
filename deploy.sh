#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Tefo Desk production deploy for tefudesk.fastlaneorders.online.
# Binds application containers to loopback only; Nginx owns public HTTP/HTTPS.
DOMAIN="${DOMAIN:-tefudesk.fastlaneorders.online}"
EMAIL="${EMAIL:-ndumygums@gmail.com}"
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-4510}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-4511}"
ENV_FILE="$APP_DIR/.env.production"
COMPOSE_FILE="$APP_DIR/docker-compose.prod.yml"
NGINX_AVAILABLE="/etc/nginx/sites-available/$DOMAIN"
NGINX_ENABLED="/etc/nginx/sites-enabled/$DOMAIN"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
MARKER="# managed-by tefo-desk deploy.sh"

info() { printf '\033[0;32m[INFO]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

[[ "$EUID" -eq 0 ]] || fail "Run on the VPS as root: sudo bash deploy.sh"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Invalid DOMAIN value."
[[ -f "$COMPOSE_FILE" && -f "$APP_DIR/Dockerfile" && -f "$APP_DIR/frontend/Dockerfile" ]] || fail "Deployment files are incomplete in $APP_DIR."

for command in docker nginx certbot openssl curl ss getent systemctl install; do
  command -v "$command" >/dev/null 2>&1 || fail "Missing prerequisite: $command"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
certbot plugins 2>/dev/null | grep -q 'nginx' || fail "Certbot's Nginx plugin is required."
[[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]] || fail "Expected Debian/Ubuntu Nginx site directories."

BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-$(env_value BACKEND_HOST_PORT)}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-$(env_value FRONTEND_HOST_PORT)}"
BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-4510}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-4511}"

for port in "$BACKEND_HOST_PORT" "$FRONTEND_HOST_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || fail "Invalid host port: $port"
  if ss -ltnH | awk '{print $4}' | grep -Eq ":${port}$"; then
    fail "Host port $port is already listening. Choose unused BACKEND_HOST_PORT / FRONTEND_HOST_PORT values."
  fi
done

DNS_IPS="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true)"
[[ -n "$DNS_IPS" ]] || fail "$DOMAIN does not resolve to an IPv4 address yet. Set its DNS A record to this VPS and retry."
SERVER_IP="$(curl -4fsS --max-time 8 https://api.ipify.org || true)"
if [[ -n "$SERVER_IP" ]] && ! grep -Fxq "$SERVER_IP" <<<"$DNS_IPS"; then
  warn "$DOMAIN resolves to $DNS_IPS, while the VPS public IPv4 is $SERVER_IP. If using a DNS proxy, confirm it routes HTTP/HTTPS to this server; Certbot will verify the route before issuing SSL."
fi

prompt_secret() {
  local key="$1" label="$2" value
  read -r -s -p "$label: " value
  printf '\n' >&2
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$key cannot be blank or multiline."
  printf -v "$key" '%s' "$value"
}

if [[ -f "$ENV_FILE" ]]; then
  chmod 600 "$ENV_FILE"
  PAYPAL_CLIENT_ID="$(env_value PAYPAL_CLIENT_ID)"
  PAYPAL_CLIENT_SECRET="$(env_value PAYPAL_CLIENT_SECRET)"
  AI_API_KEY="$(env_value AI_API_KEY)"
  AI_MODEL="$(env_value AI_MODEL)"
  if [[ -z "$PAYPAL_CLIENT_ID" || "$PAYPAL_CLIENT_ID" == YOUR_* ]]; then prompt_secret PAYPAL_CLIENT_ID "PayPal Sandbox Client ID"; fi
  if [[ -z "$PAYPAL_CLIENT_SECRET" || "$PAYPAL_CLIENT_SECRET" == YOUR_* ]]; then prompt_secret PAYPAL_CLIENT_SECRET "PayPal Sandbox Secret"; fi
  if [[ -z "$AI_API_KEY" || "$AI_API_KEY" == YOUR_* ]]; then prompt_secret AI_API_KEY "Gemini API key"; fi
  if [[ -z "$AI_MODEL" || "$AI_MODEL" == YOUR_* ]]; then
    read -r -p "Gemini model enabled for your Google AI project: " AI_MODEL
  fi
else
  info "Credentials are entered invisibly and stored only in $ENV_FILE (mode 600)."
  prompt_secret PAYPAL_CLIENT_ID "PayPal Sandbox Client ID"
  prompt_secret PAYPAL_CLIENT_SECRET "PayPal Sandbox Secret"
  prompt_secret AI_API_KEY "Gemini API key"
  read -r -p "Gemini model enabled for your Google AI project: " AI_MODEL
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
EMAIL=$EMAIL
APP_ORIGIN=https://$DOMAIN
NEXT_PUBLIC_API_BASE_URL=https://$DOMAIN/api/v1
BACKEND_HOST_PORT=$BACKEND_HOST_PORT
FRONTEND_HOST_PORT=$FRONTEND_HOST_PORT
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
COOKIE_SECURE=true
SESSION_TTL_DAYS=14
POSTGRES_USER=tefo
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=tefo_desk
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=$PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET=$PAYPAL_CLIENT_SECRET
PAYPAL_WEBHOOK_ID=
AI_PROVIDER=gemini
AI_MODEL=$AI_MODEL
AI_API_KEY=$AI_API_KEY
AI_BASE_URL=
AI_TIMEOUT_MS=15000
AI_MAX_RETRIES=1
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
fi

[[ -n "$BACKEND_HOST_PORT" && -n "$FRONTEND_HOST_PORT" ]] || fail "Backend/frontend bind ports are missing in $ENV_FILE."

for key in PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET AI_API_KEY AI_MODEL POSTGRES_PASSWORD; do
  value="$(env_value "$key")"
  [[ -n "$value" && "$value" != YOUR_* && "$value" != GENERATE_* ]] || fail "$key is missing or still a placeholder in $ENV_FILE."
done

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

info "Building production API, migration, and standalone web images."
cd "$APP_DIR"
dc build backend migrate frontend
info "Starting the private database."
dc up -d postgres
info "Applying checked-in Prisma migrations."
dc run --rm migrate
info "Starting the API and frontend on 127.0.0.1:$BACKEND_HOST_PORT and 127.0.0.1:$FRONTEND_HOST_PORT."
dc up -d --no-build backend frontend

for service in backend frontend; do
  container="$(dc ps -q "$service")"
  [[ -n "$container" ]] || fail "$service container did not start. Check: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs $service"
  healthy=false
  for _ in $(seq 1 60); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    if [[ "$state" == healthy ]]; then healthy=true; break; fi
    if [[ "$state" == unhealthy || "$state" == exited || "$state" == dead ]]; then break; fi
    sleep 2
  done
  [[ "$healthy" == true ]] || fail "$service did not become healthy. Inspect its Compose logs before retrying."
done

if [[ -e "$NGINX_AVAILABLE" && ! -L "$NGINX_AVAILABLE" ]] && ! grep -Fq "$MARKER" "$NGINX_AVAILABLE"; then
  fail "Nginx config $NGINX_AVAILABLE already exists and is not managed by this script; refusing to overwrite it."
fi
if [[ -L "$NGINX_AVAILABLE" ]]; then
  fail "Nginx available-site path $NGINX_AVAILABLE is itself a symlink; refusing to change it."
fi
if [[ -L "$NGINX_ENABLED" ]] && [[ "$(readlink -f "$NGINX_ENABLED")" != "$(readlink -m "$NGINX_AVAILABLE")" ]]; then
  fail "Nginx enabled-site path $NGINX_ENABLED points elsewhere; refusing to replace it."
fi

if [[ ! -f "$NGINX_AVAILABLE" ]]; then
  cat > "$NGINX_AVAILABLE" <<EOF
$MARKER
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 2m;

    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_HOST_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass http://127.0.0.1:$FRONTEND_HOST_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
  chmod 644 "$NGINX_AVAILABLE"
fi
if [[ ! -e "$NGINX_ENABLED" ]]; then ln -s "$NGINX_AVAILABLE" "$NGINX_ENABLED"; fi
nginx -t || fail "Nginx rejected the Tefo Desk site configuration."
systemctl reload nginx

if [[ ! -d "$CERT_DIR" ]]; then
  info "Requesting a Let's Encrypt certificate for $DOMAIN."
  certbot --nginx --non-interactive --agree-tos --redirect -d "$DOMAIN" -m "$EMAIL"
else
  info "Installing the existing Let's Encrypt certificate in Nginx."
  certbot install --cert-name "$DOMAIN" --nginx
fi

nginx -t || fail "Nginx configuration is invalid after SSL setup."
systemctl reload nginx
curl -fsS --retry 8 --retry-delay 2 --retry-connrefused "https://$DOMAIN/" -o /dev/null || fail "HTTPS frontend smoke check failed."
API_STATUS="$(curl -sS --retry 8 --retry-delay 2 --retry-connrefused -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/v1/auth/me")" || fail "HTTPS API smoke check failed."
[[ "$API_STATUS" == 401 || "$API_STATUS" == 200 ]] || fail "API smoke check returned HTTP $API_STATUS."

info "Deployment ready: https://$DOMAIN"
info "API: https://$DOMAIN/api/v1 | private host ports: $BACKEND_HOST_PORT (API), $FRONTEND_HOST_PORT (web)"
info "Secrets file: $ENV_FILE (permissions $(stat -c '%a' "$ENV_FILE")). It is excluded from Docker and Git."
info "Useful commands: cd $APP_DIR && docker compose --env-file .env.production -f docker-compose.prod.yml ps"
info "Logs: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs -f backend frontend"
