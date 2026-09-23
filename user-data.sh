#!/bin/bash
set -e
exec > /var/log/ordergrid-init.log 2>&1

echo "Starting OrderGrid AWS setup..."
apt-get update -y
apt-get install -y git curl ca-certificates docker.io docker-compose-v2

systemctl enable --now docker
usermod -aG docker ubuntu

echo "Cloning repository..."
mkdir -p /opt/ordergrid
git clone https://github.com/Tashima-Tarsh/ordergrid.git /opt/ordergrid
cd /opt/ordergrid

PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 || curl -s ifconfig.me || echo "localhost")

cat <<EOF > /opt/ordergrid/.env
NODE_ENV=production
PORT=3000
APP_ORIGIN=http://${PUBLIC_IP}:3000
DATABASE_URL=postgres://ordergrid:OrderGrid2026SecurePostgres!@db:5432/ordergrid
REDIS_URL=redis://redis:6379
SESSION_SECRET=ordergrid_session_secret_2026_super_secure_32bytes
DATA_ENCRYPTION_KEY_BASE64=YXV0b2dlbmVyYXRlZF8zMmJ5dGVfa2V5X2Zvcg==1234567890abcdef
WORKER_API_TOKEN=ordergrid_worker_token_secure_min_32_chars_2026
BOOTSTRAP_ADMIN_EMAIL=amyhod3@gmail.com
BOOTSTRAP_ADMIN_PASSWORD=OrderGrid2026SecureAdmin!
AWS_REGION=ap-south-1
BEDROCK_REGION=ap-south-1
BEDROCK_MODEL_ID=apac.amazon.nova-lite-v1:0
EOF

echo "Building and starting Docker services..."
docker compose up -d --build

echo "OrderGrid successfully deployed on AWS!"
