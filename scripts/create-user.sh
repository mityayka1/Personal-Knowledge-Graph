#!/bin/bash
# create-user.sh - Create or update user in PKG database
#
# This script runs from the HOST machine (not inside container)
# because bcrypt may not be available in production containers.
#
# Usage:
#   ./scripts/create-user.sh <username> [password] [role]
#
# Arguments:
#   username - Required. Username for the account
#   password - Optional. If not provided, generates random 16-char password
#   role     - Optional. Default: admin. Options: admin, user
#
# Examples:
#   ./scripts/create-user.sh admin                    # Random password, admin role
#   ./scripts/create-user.sh admin my-password        # Specified password, admin role
#   ./scripts/create-user.sh viewer secret123 user    # Specified password, user role

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOCKER_COMPOSE_DIR="${PKG_DOCKER_DIR:-docker}"
DB_CONTAINER="${PKG_DB_CONTAINER:-pkg-postgres}"
DB_USER="${PKG_DB_USER:-pkg}"
DB_NAME="${PKG_DB_NAME:-pkg}"

# Arguments
USERNAME="${1}"
PASSWORD="${2}"
ROLE="${3:-admin}"

# Validate arguments
if [ -z "$USERNAME" ]; then
    echo -e "${RED}Error: Username is required${NC}"
    echo ""
    echo "Usage: $0 <username> [password] [role]"
    echo ""
    echo "Examples:"
    echo "  $0 admin                    # Random password, admin role"
    echo "  $0 admin my-password        # Specified password, admin role"
    echo "  $0 viewer secret123 user    # Specified password, user role"
    exit 1
fi

# Validate role
if [ "$ROLE" != "admin" ] && [ "$ROLE" != "user" ]; then
    echo -e "${RED}Error: Invalid role '$ROLE'. Must be 'admin' or 'user'${NC}"
    exit 1
fi

# Generate password if not provided
if [ -z "$PASSWORD" ]; then
    PASSWORD=$(openssl rand -base64 16 | tr -d '/+=' | head -c 16)
    GENERATED_PASSWORD=true
else
    GENERATED_PASSWORD=false
fi

echo -e "${YELLOW}Creating/updating user: $USERNAME (role: $ROLE)${NC}"

# Check if bcrypt is available locally
if ! node -e "require('bcrypt')" 2>/dev/null; then
    echo -e "${RED}Error: bcrypt module not found locally${NC}"
    echo ""
    echo "Please install bcrypt in your local environment:"
    echo "  npm install bcrypt"
    echo ""
    echo "Or use a Node.js environment with bcrypt available."
    exit 1
fi

# Generate bcrypt hash
echo "Generating password hash..."
HASH=$(node -e "
const bcrypt = require('bcrypt');
bcrypt.hash('$PASSWORD', 12).then(h => console.log(h)).catch(e => {
    console.error('Hash error:', e.message);
    process.exit(1);
});
")

if [ -z "$HASH" ]; then
    echo -e "${RED}Error: Failed to generate password hash${NC}"
    exit 1
fi

# Escape special characters for SQL
# Note: bcrypt hashes contain $ which needs escaping
ESCAPED_HASH=$(echo "$HASH" | sed "s/'/''/" | sed 's/\$/\\$/g')

# Check if postgres container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    # Try with docker compose
    echo "Looking for postgres container..."
    if [ -d "$DOCKER_COMPOSE_DIR" ]; then
        cd "$DOCKER_COMPOSE_DIR"
        DB_CONTAINER=$(docker compose ps --format '{{.Name}}' 2>/dev/null | grep -E 'postgres|db' | head -1)
        cd - > /dev/null
    fi

    if [ -z "$DB_CONTAINER" ]; then
        echo -e "${RED}Error: Cannot find postgres container${NC}"
        echo "Make sure docker containers are running: docker compose ps"
        exit 1
    fi
fi

echo "Using database container: $DB_CONTAINER"

# Execute SQL to create/update user
echo "Inserting user into database..."

docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
INSERT INTO users (
    id,
    username,
    password_hash,
    display_name,
    role,
    status,
    failed_login_attempts,
    created_at,
    updated_at
) VALUES (
    gen_random_uuid(),
    '$USERNAME',
    '$ESCAPED_HASH',
    '$USERNAME',
    '$ROLE',
    'active',
    0,
    NOW(),
    NOW()
)
ON CONFLICT (username) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    status = 'active',
    failed_login_attempts = 0,
    locked_until = NULL,
    updated_at = NOW();
EOF

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}User '$USERNAME' created/updated successfully!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Username: ${GREEN}$USERNAME${NC}"
    echo -e "Role:     ${GREEN}$ROLE${NC}"

    if [ "$GENERATED_PASSWORD" = true ]; then
        echo -e "Password: ${YELLOW}$PASSWORD${NC}"
        echo ""
        echo -e "${YELLOW}NOTE: This is a generated password. Save it securely!${NC}"
    else
        echo "Password: (as provided)"
    fi
    echo ""
else
    echo -e "${RED}Error: Failed to create/update user${NC}"
    exit 1
fi
