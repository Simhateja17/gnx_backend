#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# Globonexo Backend — GCP VM Deployment Script
# Run this on the GCP VM via SSH:
#   bash deploy-gcp.sh
# ─────────────────────────────────────────────────────────

APP_DIR="$HOME/globonexo-backend"
REPO_URL="https://github.com/Simhateja17/gnx_backend.git"
NODE_VERSION="20"

echo "========================================="
echo "  Globonexo Backend — GCP VM Setup"
echo "========================================="

# ── 1. System packages ──────────────────────────────────
echo ""
echo "[1/7] Installing system dependencies..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential

# ── 2. Node.js (via NodeSource) ─────────────────────────
if command -v node &>/dev/null; then
  echo "[2/7] Node.js already installed: $(node -v)"
else
  echo "[2/7] Installing Node.js ${NODE_VERSION}.x..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "  Installed: $(node -v) / npm $(npm -v)"
fi

# ── 3. Redis ────────────────────────────────────────────
if command -v redis-server &>/dev/null; then
  echo "[3/7] Redis already installed: $(redis-server --version)"
else
  echo "[3/7] Installing Redis..."
  sudo apt-get install -y redis-server
  sudo systemctl enable redis-server
  sudo systemctl start redis-server
fi

# Verify Redis is running
if redis-cli ping | grep -q PONG; then
  echo "  Redis is running (PONG)"
else
  echo "  WARNING: Redis not responding. Starting it..."
  sudo systemctl start redis-server
fi

# ── 4. PM2 (global) ────────────────────────────────────
if command -v pm2 &>/dev/null; then
  echo "[4/7] PM2 already installed: $(pm2 -v)"
else
  echo "[4/7] Installing PM2 globally..."
  sudo npm install -g pm2
fi

# ── 5. Clone or pull the repo ───────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "[5/7] Pulling latest code..."
  cd "$APP_DIR"
  git pull origin main
else
  echo "[5/7] Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# ── 6. Install deps & build ────────────────────────────
echo "[6/7] Installing dependencies & building..."
cd "$APP_DIR"
npm ci --omit=dev
npm run build

# Create logs directory
mkdir -p logs

# ── 7. Environment file ────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  echo "[7/7] Creating .env from .env.example..."
  cp .env.example .env
  echo ""
  echo "  ╔══════════════════════════════════════════════╗"
  echo "  ║  IMPORTANT: Edit .env with real credentials  ║"
  echo "  ║  nano ~/globonexo-backend/.env               ║"
  echo "  ╚══════════════════════════════════════════════╝"
  echo ""
else
  echo "[7/7] .env already exists — skipping."
fi

# ── 8. Start with PM2 ──────────────────────────────────
echo ""
echo "Starting services with PM2..."
cd "$APP_DIR"
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# Set PM2 to auto-start on boot
echo ""
echo "Setting up PM2 startup on boot..."
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" || true
pm2 save

echo ""
echo "========================================="
echo "  Deployment complete!"
echo "========================================="
echo ""
pm2 list
echo ""
echo "Useful commands:"
echo "  pm2 logs                  — view all logs"
echo "  pm2 logs globonexo-api    — view API logs"
echo "  pm2 logs globonexo-workers — view worker logs"
echo "  pm2 list                  — process status"
echo "  pm2 restart all           — restart everything"
echo "  nano ~/globonexo-backend/.env — edit config"
echo ""
