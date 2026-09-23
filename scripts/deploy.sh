#!/usr/bin/env bash
set -euo pipefail

REF="${1:-}"
if [ -z "$REF" ]; then
  echo "Usage: scripts/deploy.sh <immutable-tag-or-sha>" >&2
  exit 1
fi

# Validation: release tag (e.g. v1.0.0) or 40-char hex SHA
if [[ ! "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9]+)*$ && ! "$REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Error: Deployment ref must be an immutable release tag (e.g. v1.0.0) or a 40-character commit SHA." >&2
  echo "Branch names (main, master, HEAD) are rejected to prevent non-reproducible deployments." >&2
  exit 1
fi

echo "==> Deploying OrderGrid ref: $REF"

# 1. Fetch & checkout ref
git fetch --depth 1 origin "$REF"
PREV_REF="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
git checkout --detach "$REF"
echo "$REF" > DEPLOYED_REF

# 2. Pre-deployment database backup
if [ -n "${DATABASE_URL:-}" ]; then
  BACKUP_DIR="backups"
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/backup-pre-deploy-$(date +%s).sql"
  echo "==> Creating database backup at $BACKUP_FILE"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump "$DATABASE_URL" > "$BACKUP_FILE" || echo "Warning: pg_dump backup failed, continuing..."
  else
    echo "Note: pg_dump not found in PATH, skipping local pg_dump."
  fi
fi

# 3. Install dependencies & build
echo "==> Installing dependencies and building assets"
npm ci --omit=dev || npm install --omit=dev
npm run build

# 4. Run database migrations
echo "==> Running database migrations"
npm run db:migrate

# 5. Restart services (if using docker compose)
if [ -f "docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
  echo "==> Restarting container services"
  docker compose up -d --build
fi

# 6. Health check polling (up to 120 seconds)
APP_URL="${APP_ORIGIN:-http://localhost:3000}"
HEALTH_URL="${APP_URL%/}/api/health"
echo "==> Waiting for service health check at $HEALTH_URL (timeout 120s)..."

HEALTHY=false
for i in $(seq 1 24); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  echo "Waiting for health check... ($((i * 5))s / 120s)"
  sleep 5
done

if [ "$HEALTHY" = true ]; then
  echo "==> Deployment of $REF successful!"
  exit 0
else
  echo "==> ERROR: Health check failed after 120 seconds." >&2
  echo "==> ROLLBACK INSTRUCTIONS:" >&2
  echo "    To roll back to the previous revision ($PREV_REF):" >&2
  echo "    1. git checkout --detach $PREV_REF" >&2
  echo "    2. npm ci && npm run build" >&2
  echo "    3. docker compose up -d --build" >&2
  if [ -n "${BACKUP_FILE:-}" ] && [ -f "$BACKUP_FILE" ]; then
    echo "    4. If database rollback is needed: psql \"\$DATABASE_URL\" < $BACKUP_FILE" >&2
  fi
  exit 1
fi
