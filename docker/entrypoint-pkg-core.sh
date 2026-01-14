#!/bin/sh
set -e

# Copy Claude credentials if available (runs as root, then chown)
if [ -f /tmp/claude-credentials.json ]; then
  mkdir -p /home/nestjs/.claude
  cp /tmp/claude-credentials.json /home/nestjs/.claude/.credentials.json
  chown -R nestjs:nodejs /home/nestjs/.claude
  echo "Claude credentials copied"
fi

# Switch to nestjs user and start the application
exec su-exec nestjs node apps/pkg-core/dist/main.js
