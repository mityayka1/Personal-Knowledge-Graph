#!/bin/bash
#
# Remote Telegram Authorization Script
#
# Authorizes Telegram session on remote server via SSH.
# Requires interactive TTY for phone code and 2FA input.
#
# Usage:
#   ./scripts/remote-telegram-auth.sh [user@]host
#
# Examples:
#   ./scripts/remote-telegram-auth.sh deploy@my-server.com
#   ./scripts/remote-telegram-auth.sh root@192.168.1.100
#
# After successful authorization, the script will:
# 1. Generate new session string
# 2. Update .env file on the server
# 3. Restart telegram-adapter container
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
PKG_PATH="${PKG_REMOTE_PATH:-/opt/apps/pkg}"
DOCKER_COMPOSE_DIR="$PKG_PATH/docker"

# Parse arguments
if [ -z "$1" ]; then
    echo -e "${RED}Error: SSH host required${NC}"
    echo ""
    echo "Usage: $0 [user@]host"
    echo ""
    echo "Examples:"
    echo "  $0 deploy@my-server.com"
    echo "  $0 root@192.168.1.100"
    echo ""
    echo "Environment variables:"
    echo "  PKG_REMOTE_PATH - Path to PKG on server (default: /opt/apps/pkg)"
    exit 1
fi

SSH_HOST="$1"

echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║         Remote Telegram Authorization                         ║${NC}"
echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Server: ${GREEN}$SSH_HOST${NC}"
echo -e "PKG path: ${GREEN}$PKG_PATH${NC}"
echo ""

# Step 1: Stop telegram-adapter to release session
echo -e "${YELLOW}[1/5] Stopping telegram-adapter...${NC}"
ssh "$SSH_HOST" "cd $DOCKER_COMPOSE_DIR && docker compose stop telegram-adapter" || true
echo -e "${GREEN}      Stopped.${NC}"
echo ""

# Step 2: Run auth script interactively
echo -e "${YELLOW}[2/5] Starting authorization...${NC}"
echo -e "      ${YELLOW}You will be prompted for:${NC}"
echo -e "      - Phone number (with country code, e.g., +7...)"
echo -e "      - Verification code (from Telegram)"
echo -e "      - 2FA password (if enabled)"
echo ""

# Run auth and capture the session string
# The auth script outputs the session string at the end
SESSION_OUTPUT=$(ssh -t "$SSH_HOST" "cd $PKG_PATH/apps/telegram-adapter && \
    source ~/.nvm/nvm.sh 2>/dev/null || true && \
    npx ts-node scripts/auth.ts 2>&1" | tee /dev/tty)

# Extract session string from output (last line starting with "1")
NEW_SESSION=$(echo "$SESSION_OUTPUT" | grep -E "^1[A-Za-z0-9+/=]+" | tail -1 | tr -d '\r\n')

if [ -z "$NEW_SESSION" ] || [ ${#NEW_SESSION} -lt 100 ]; then
    echo ""
    echo -e "${RED}Error: Could not extract session string from output${NC}"
    echo "Please check the output above for errors."
    echo ""
    echo "If authorization was successful, you can manually update .env:"
    echo "  ssh $SSH_HOST"
    echo "  cd $DOCKER_COMPOSE_DIR"
    echo "  # Edit .env and set TELEGRAM_SESSION_STRING"
    echo "  docker compose up -d telegram-adapter"
    exit 1
fi

echo ""
echo -e "${GREEN}      Authorization successful!${NC}"
echo -e "      Session string length: ${#NEW_SESSION} chars"
echo ""

# Step 3: Update .env file
echo -e "${YELLOW}[3/5] Updating .env file...${NC}"
ssh "$SSH_HOST" "cd $DOCKER_COMPOSE_DIR && \
    cp .env .env.backup.\$(date +%Y%m%d_%H%M%S) && \
    sed -i 's|^TELEGRAM_SESSION_STRING=.*|TELEGRAM_SESSION_STRING=$NEW_SESSION|' .env"
echo -e "${GREEN}      .env updated (backup created).${NC}"
echo ""

# Step 4: Start telegram-adapter
echo -e "${YELLOW}[4/5] Starting telegram-adapter...${NC}"
ssh "$SSH_HOST" "cd $DOCKER_COMPOSE_DIR && docker compose up -d telegram-adapter"
echo ""

# Step 5: Verify connection
echo -e "${YELLOW}[5/5] Verifying connection (waiting 10s)...${NC}"
sleep 10

if ssh "$SSH_HOST" "docker logs pkg-telegram-adapter 2>&1 | tail -20 | grep -q 'Connected to Telegram'"; then
    echo -e "${GREEN}      ✓ Connected to Telegram successfully!${NC}"
else
    echo -e "${YELLOW}      ⚠ Could not verify connection. Check logs:${NC}"
    echo -e "      ssh $SSH_HOST 'docker logs -f pkg-telegram-adapter'"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Authorization Complete                                ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "To check logs:"
echo "  ssh $SSH_HOST 'docker logs -f pkg-telegram-adapter'"
echo ""
