#!/usr/bin/env bash
# start-agent.sh — Chạy agent với auto-restart khi crash (Linux/macOS).
# Windows: dùng start-agent.bat tương ứng.
# chmod +x start-agent.sh && ./start-agent.sh
cd "$(dirname "$0")"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting YT-Queue-Agent..."
  node agent.js
  EXIT_CODE=$?
  echo ""
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Agent stopped (exit code $EXIT_CODE). Restarting in 10 seconds..."
  echo "Press Ctrl+C to exit completely."
  sleep 10
done
