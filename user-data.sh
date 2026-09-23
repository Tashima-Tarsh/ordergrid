#!/bin/bash
set -e
exec > /var/log/ordergrid-init.log 2>&1

echo "Starting OrderGrid AWS setup..."
apt-get update -y
apt-get install -y git curl ca-certificates docker.io docker-compose-v2

systemctl enable --now docker
usermod -aG docker ubuntu

ORDERGRID_REF="${ORDERGRID_REF:-v1.0.0}"
if [[ ! "$ORDERGRID_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9]+)*$ && ! "$ORDERGRID_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Error: ORDERGRID_REF must be an immutable release tag (e.g. v1.0.0) or 40-character commit SHA. Got: $ORDERGRID_REF" >&2
  exit 1
fi

echo "Cloning repository at ref $ORDERGRID_REF..."
mkdir -p /opt/ordergrid
cd /opt/ordergrid
if [ ! -d ".git" ]; then
  git init
  git remote add origin https://github.com/Tashima-Tarsh/ordergrid.git
fi
git fetch --depth 1 origin "$ORDERGRID_REF"
git checkout --detach "$ORDERGRID_REF"
echo "$ORDERGRID_REF" > /opt/ordergrid/DEPLOYED_REF

PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 || curl -s ifconfig.me || echo "localhost")
SESSION_SECRET_VAL=$(openssl rand -hex 32)
DATA_ENCRYPTION_KEY_VAL=$(openssl rand -base64 32)
WORKER_API_TOKEN_VAL=$(openssl rand -hex 32)
BOOTSTRAP_ADMIN_PASSWORD_VAL=$(openssl rand -base64 16)
DB_PASSWORD_VAL=$(openssl rand -base64 16)

cat <<EOF > /opt/ordergrid/.env
NODE_ENV=production
PORT=3000
APP_ORIGIN=http://${PUBLIC_IP}:3000
POSTGRES_PASSWORD=${DB_PASSWORD_VAL}
DATABASE_URL=postgres://ordergrid:${DB_PASSWORD_VAL}@db:5432/ordergrid
REDIS_URL=redis://redis:6379
SESSION_SECRET=${SESSION_SECRET_VAL}
DATA_ENCRYPTION_KEY_BASE64=${DATA_ENCRYPTION_KEY_VAL}
WORKER_API_TOKEN=${WORKER_API_TOKEN_VAL}
BOOTSTRAP_ADMIN_EMAIL=admin@ordergrid.internal
BOOTSTRAP_ADMIN_PASSWORD=${BOOTSTRAP_ADMIN_PASSWORD_VAL}
AWS_REGION=ap-south-1
BEDROCK_REGION=ap-south-1
BEDROCK_MODEL_ID=apac.amazon.nova-lite-v1:0
EOF

echo "Building and starting Docker services..."
docker compose up -d --build

echo "OrderGrid successfully deployed on AWS!"
