#!/bin/sh
set -e

# Claude credentials management:
# - Copy from host if credentials don't exist in volume
# - Copy from host if host file is newer (user did `claude login`)
# - Otherwise preserve volume credentials (allow Claude to refresh tokens)
if [ -f /tmp/claude-credentials.json ]; then
  mkdir -p /home/nestjs/.claude
  DEST=/home/nestjs/.claude/.credentials.json

  if [ ! -f "$DEST" ]; then
    # First time: copy credentials from host
    cp /tmp/claude-credentials.json "$DEST"
    chown -R nestjs:nodejs /home/nestjs/.claude
    echo "Claude credentials initialized from host"
  elif [ /tmp/claude-credentials.json -nt "$DEST" ]; then
    # Host file is newer (user did `claude login`)
    cp /tmp/claude-credentials.json "$DEST"
    chown nestjs:nodejs "$DEST"
    echo "Claude credentials updated from host (newer file)"
  else
    # Volume credentials are newer or same age (possibly refreshed by Claude)
    echo "Claude credentials preserved (volume has valid/refreshed tokens)"
  fi
fi

# Ensure PATH includes npm global bin and set HOME for nestjs
export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export HOME="/home/nestjs"

# Switch to nestjs user and start the application
exec su-exec nestjs node apps/pkg-core/dist/main.js
