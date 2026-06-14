#!/bin/bash
set -e

git pull origin main
npm ci
npm run build
pm2 reload ecosystem.config.js --env production

echo "Deploy complete"
