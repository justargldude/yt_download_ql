#!/usr/bin/env bash
# start_tunnel.sh — Start ngrok tunnel with static domain

PORT=8765
DOMAIN="untagged-unleaded-bonelike.ngrok-free.dev"

clear
echo "=========================================="
echo "         PTIT DLib ngrok Tunnel"
echo "=========================================="
echo "  Domain: $DOMAIN"
echo "  Port:   $PORT"
echo "  Owner:  Local agent must be running (npm start / start.sh)"
echo "=========================================="
echo ""
echo "Starting tunnel... Press Ctrl+C to stop."
echo ""

# Check if ngrok is available
if ! command -v ngrok &>/dev/null; then
    echo "ERROR: ngrok is not found on your system PATH."
    echo "Please install it: snap install ngrok  or  sudo apt install ngrok"
    exit 1
fi

# Run ngrok
ngrok http "$PORT" --domain="$DOMAIN"
