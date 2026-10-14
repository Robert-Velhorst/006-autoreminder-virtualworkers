#!/bin/bash

# VA Dashboard - Implementation Verification Script
# This script verifies that all improvements have been properly implemented

set -e

echo "🔍 VA Dashboard - Implementation Verification"
echo "=============================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Function to check if file exists
check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} File exists: $1"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}✗${NC} File missing: $1"
        ((FAILED++))
        return 1
    fi
}

# Function to check if directory exists
check_dir() {
    if [ -d "$1" ]; then
        echo -e "${GREEN}✓${NC} Directory exists: $1"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}✗${NC} Directory missing: $1"
        ((FAILED++))
        return 1
    fi
}

# Function to check if string exists in file
check_content() {
    if grep -q "$2" "$1" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} Content found in $1: $2"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}✗${NC} Content missing in $1: $2"
        ((FAILED++))
        return 1
    fi
}

echo "📁 Checking New Files..."
echo "------------------------"

# Backend Services & Middleware
check_file "server/middleware/rate-limiter.ts"
check_file "server/utils/logger.ts"
check_file "server/utils/pagination.ts"
check_file "server/services/batch-operations-service.ts"
check_file "server/services/conflict-resolution-service.ts"
check_file "server/routes/batch-operations.ts"
check_file "server/routes/health.ts"

echo ""
echo "🐳 Checking Docker Files..."
echo "---------------------------"

check_file "Dockerfile"
check_file "docker-compose.yml"
check_file ".dockerignore"

echo ""
echo "🧪 Checking Test Files..."
echo "-------------------------"

check_file "playwright.config.ts"
check_file "e2e/auth.spec.ts"
check_file "e2e/tasks.spec.ts"
check_file "e2e/settings.spec.ts"

echo ""
echo "📚 Checking Documentation..."
echo "----------------------------"

check_file "DEPLOYMENT.md"
check_file "IMPROVEMENTS_SUMMARY.md"
check_file "QUICK_START_GUIDE.md"
check_file "IMPLEMENTATION_COMPLETE.md"

echo ""
echo "🔧 Checking Modified Files..."
echo "-----------------------------"

# Check if rate limiting is imported
check_content "server/_core/index.ts" "rate-limiter"

# Check if logger is imported
check_content "server/_core/index.ts" "logger"

# Check if health routes are imported
check_content "server/_core/index.ts" "health"

# Check if batch operations routes are imported
check_content "server/_core/index.ts" "batch-operations"

# Check if dead code is removed
if ! grep -q "startDigestScheduler" "server/_core/index.ts" 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Dead code removed: startDigestScheduler"
    ((PASSED++))
else
    echo -e "${RED}✗${NC} Dead code still present: startDigestScheduler"
    ((FAILED++))
fi

if ! grep -q "initializeWebhookAutoRegister" "server/_core/index.ts" 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Dead code removed: initializeWebhookAutoRegister"
    ((PASSED++))
else
    echo -e "${RED}✗${NC} Dead code still present: initializeWebhookAutoRegister"
    ((FAILED++))
fi

# Check if new scripts are in package.json
check_content "package.json" "test:e2e"
check_content "package.json" "docker:build"
check_content "package.json" "docker:run"

echo ""
echo "🔍 Checking Implementation Details..."
echo "-------------------------------------"

# Check rate limiter implementation
check_content "server/middleware/rate-limiter.ts" "createRateLimiter"
check_content "server/middleware/rate-limiter.ts" "authRateLimiter"
check_content "server/middleware/rate-limiter.ts" "apiRateLimiter"

# Check logger implementation
check_content "server/utils/logger.ts" "class Logger"
check_content "server/utils/logger.ts" "LogLevel"
check_content "server/utils/logger.ts" "export const logger"

# Check batch operations implementation
check_content "server/services/batch-operations-service.ts" "createBatchOperation"
check_content "server/services/batch-operations-service.ts" "executeBatchOperation"
check_content "server/services/batch-operations-service.ts" "getBatchOperationStatus"

# Check conflict resolution implementation
check_content "server/services/conflict-resolution-service.ts" "detectConflicts"
check_content "server/services/conflict-resolution-service.ts" "resolveConflicts"

# Check pagination implementation
check_content "server/utils/pagination.ts" "parsePaginationParams"
check_content "server/utils/pagination.ts" "createPaginatedResponse"

# Check health check implementation
check_content "server/routes/health.ts" "/api/health"
check_content "server/routes/health.ts" "/api/health/ready"
check_content "server/routes/health.ts" "/api/health/live"

echo ""
echo "🐳 Checking Docker Configuration..."
echo "-----------------------------------"

# Check Dockerfile
check_content "Dockerfile" "FROM node:24.21.0-alpine3.23"
check_content "Dockerfile" "HEALTHCHECK"
check_content "Dockerfile" "USER nodejs"

# Check docker-compose.yml uses one application container and external services
check_content "docker-compose.yml" "app:"
check_content "docker-compose.yml" "healthcheck:"
check_content "docker-compose.yml" "host.docker.internal:host-gateway"
if grep -Eq '^  (postgres|mysql|redis|migrate):' docker-compose.yml; then
    echo -e "${RED}✗${NC} Compose must not start database, cache, or migration containers"
    FAILED=$((FAILED + 1))
else
    echo -e "${GREEN}✓${NC} Compose starts no auxiliary containers"
    PASSED=$((PASSED + 1))
fi

echo ""
echo "📊 Verification Summary"
echo "======================="
echo ""
echo -e "Passed: ${GREEN}${PASSED}${NC}"
echo -e "Failed: ${RED}${FAILED}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed! Implementation is complete.${NC}"
    echo ""
    echo "🚀 Next Steps:"
    echo "  1. Configure DATABASE_URL with a PostgreSQL connection and install dependencies"
    echo "  2. Apply reviewed migrations from a trusted host with 'pnpm db:migrate'"
    echo "  3. Start the single app container with 'docker compose up -d --build'"
    echo "  4. Open the loopback URL configured by PORT (default http://localhost:3025)"
    echo ""
    exit 0
else
    echo -e "${RED}❌ Some checks failed. Please review the output above.${NC}"
    echo ""
    exit 1
fi
