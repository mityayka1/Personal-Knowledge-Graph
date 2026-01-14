#!/bin/sh
set -e

# Copy Claude credentials if available
if [ -f /tmp/claude-credentials.json ]; then
  mkdir -p /home/nestjs/.claude
  cp /tmp/claude-credentials.json /home/nestjs/.claude/.credentials.json
  echo "Claude credentials copied"
fi

# Start the application
exec node apps/pkg-core/dist/main.js
