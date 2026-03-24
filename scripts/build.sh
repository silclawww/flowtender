#!/bin/bash
# Low-memory build script for flowtender
# Temporarily stops non-essential PM2 processes to free RAM during Next.js build

set -e
cd "$(dirname "$0")/.."

echo "[build] Stopping non-essential PM2 processes to free memory..."
pm2 stop geoscan-site geoscan-web kanban planner 2>/dev/null || true

echo "[build] Running next build..."
npm run build
BUILD_EXIT=$?

echo "[build] Restarting all PM2 processes..."
pm2 start geoscan-site geoscan-web kanban planner 2>/dev/null || true

if [ $BUILD_EXIT -eq 0 ]; then
  echo "[build] Build succeeded — restarting flowtender..."
  pm2 restart flowtender
  echo "[build] Done."
else
  echo "[build] Build FAILED (exit $BUILD_EXIT)"
  exit $BUILD_EXIT
fi
