# VA Dashboard - Implementation Verification Script (PowerShell)
# This script verifies that all improvements have been properly implemented

Write-Host "🔍 VA Dashboard - Implementation Verification" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Counters
$script:Passed = 0
$script:Failed = 0

# Function to check if file exists
function Test-FileExists {
    param([string]$Path)
    
    if (Test-Path $Path -PathType Leaf) {
        Write-Host "✓ File exists: $Path" -ForegroundColor Green
        $script:Passed++
        return $true
    } else {
        Write-Host "✗ File missing: $Path" -ForegroundColor Red
        $script:Failed++
        return $false
    }
}

# Function to check if directory exists
function Test-DirectoryExists {
    param([string]$Path)
    
    if (Test-Path $Path -PathType Container) {
        Write-Host "✓ Directory exists: $Path" -ForegroundColor Green
        $script:Passed++
        return $true
    } else {
        Write-Host "✗ Directory missing: $Path" -ForegroundColor Red
        $script:Failed++
        return $false
    }
}

# Function to check if string exists in file
function Test-ContentExists {
    param(
        [string]$Path,
        [string]$Content
    )
    
    if (Test-Path $Path) {
        $fileContent = Get-Content $Path -Raw -ErrorAction SilentlyContinue
        if ($fileContent -match [regex]::Escape($Content)) {
            Write-Host "✓ Content found in $Path`: $Content" -ForegroundColor Green
            $script:Passed++
            return $true
        }
    }
    
    Write-Host "✗ Content missing in $Path`: $Content" -ForegroundColor Red
    $script:Failed++
    return $false
}

Write-Host "📁 Checking New Files..." -ForegroundColor Yellow
Write-Host "------------------------"

# Backend Services & Middleware
Test-FileExists "server/middleware/rate-limiter.ts"
Test-FileExists "server/utils/logger.ts"
Test-FileExists "server/utils/pagination.ts"
Test-FileExists "server/services/batch-operations-service.ts"
Test-FileExists "server/services/conflict-resolution-service.ts"
Test-FileExists "server/routes/batch-operations.ts"
Test-FileExists "server/routes/health.ts"

Write-Host ""
Write-Host "🐳 Checking Docker Files..." -ForegroundColor Yellow
Write-Host "---------------------------"

Test-FileExists "Dockerfile"
Test-FileExists "docker-compose.yml"
Test-FileExists ".dockerignore"

Write-Host ""
Write-Host "🧪 Checking Test Files..." -ForegroundColor Yellow
Write-Host "-------------------------"

Test-FileExists "playwright.config.ts"
Test-FileExists "e2e/auth.spec.ts"
Test-FileExists "e2e/tasks.spec.ts"
Test-FileExists "e2e/settings.spec.ts"

Write-Host ""
Write-Host "📚 Checking Documentation..." -ForegroundColor Yellow
Write-Host "----------------------------"

Test-FileExists "DEPLOYMENT.md"
Test-FileExists "IMPROVEMENTS_SUMMARY.md"
Test-FileExists "QUICK_START_GUIDE.md"
Test-FileExists "IMPLEMENTATION_COMPLETE.md"

Write-Host ""
Write-Host "🔧 Checking Modified Files..." -ForegroundColor Yellow
Write-Host "-----------------------------"

# Check if rate limiting is imported
Test-ContentExists "server/_core/index.ts" "rate-limiter"

# Check if logger is imported
Test-ContentExists "server/_core/index.ts" "logger"

# Check if health routes are imported
Test-ContentExists "server/_core/index.ts" "health"

# Check if batch operations routes are imported
Test-ContentExists "server/_core/index.ts" "batch-operations"

# Check if dead code is removed
$indexContent = Get-Content "server/_core/index.ts" -Raw -ErrorAction SilentlyContinue
if ($indexContent -notmatch "startDigestScheduler") {
    Write-Host "✓ Dead code removed: startDigestScheduler" -ForegroundColor Green
    $script:Passed++
} else {
    Write-Host "✗ Dead code still present: startDigestScheduler" -ForegroundColor Red
    $script:Failed++
}

if ($indexContent -notmatch "initializeWebhookAutoRegister") {
    Write-Host "✓ Dead code removed: initializeWebhookAutoRegister" -ForegroundColor Green
    $script:Passed++
} else {
    Write-Host "✗ Dead code still present: initializeWebhookAutoRegister" -ForegroundColor Red
    $script:Failed++
}

# Check if new scripts are in package.json
Test-ContentExists "package.json" "test:e2e"
Test-ContentExists "package.json" "docker:build"
Test-ContentExists "package.json" "docker:run"

Write-Host ""
Write-Host "🔍 Checking Implementation Details..." -ForegroundColor Yellow
Write-Host "-------------------------------------"

# Check rate limiter implementation
Test-ContentExists "server/middleware/rate-limiter.ts" "createRateLimiter"
Test-ContentExists "server/middleware/rate-limiter.ts" "authRateLimiter"
Test-ContentExists "server/middleware/rate-limiter.ts" "apiRateLimiter"

# Check logger implementation
Test-ContentExists "server/utils/logger.ts" "class Logger"
Test-ContentExists "server/utils/logger.ts" "LogLevel"
Test-ContentExists "server/utils/logger.ts" "export const logger"

# Check batch operations implementation
Test-ContentExists "server/services/batch-operations-service.ts" "createBatchOperation"
Test-ContentExists "server/services/batch-operations-service.ts" "executeBatchOperation"
Test-ContentExists "server/services/batch-operations-service.ts" "getBatchOperationStatus"

# Check conflict resolution implementation
Test-ContentExists "server/services/conflict-resolution-service.ts" "detectConflicts"
Test-ContentExists "server/services/conflict-resolution-service.ts" "resolveConflicts"

# Check pagination implementation
Test-ContentExists "server/utils/pagination.ts" "parsePaginationParams"
Test-ContentExists "server/utils/pagination.ts" "createPaginatedResponse"

# Check health check implementation
Test-ContentExists "server/routes/health.ts" "/api/health"
Test-ContentExists "server/routes/health.ts" "/api/health/ready"
Test-ContentExists "server/routes/health.ts" "/api/health/live"

Write-Host ""
Write-Host "🐳 Checking Docker Configuration..." -ForegroundColor Yellow
Write-Host "-----------------------------------"

# Check Dockerfile
Test-ContentExists "Dockerfile" "FROM node:26.11.1-alpine3.23"
Test-ContentExists "Dockerfile" "HEALTHCHECK"
Test-ContentExists "Dockerfile" "USER nodejs"

# Check docker-compose.yml
Test-ContentExists "docker-compose.yml" "mysql:"
Test-ContentExists "docker-compose.yml" "redis:"
Test-ContentExists "docker-compose.yml" "app:"
Test-ContentExists "docker-compose.yml" "healthcheck:"

Write-Host ""
Write-Host "📊 Verification Summary" -ForegroundColor Cyan
Write-Host "=======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Passed: $script:Passed" -ForegroundColor Green
Write-Host "Failed: $script:Failed" -ForegroundColor Red
Write-Host ""

if ($script:Failed -eq 0) {
    Write-Host "✅ All checks passed! Implementation is complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "🚀 Next Steps:" -ForegroundColor Cyan
    Write-Host "  1. Run 'pnpm install' to install new dependencies"
    Write-Host "  2. Run 'docker-compose up -d' to start services"
    Write-Host "  3. Run 'docker-compose exec app pnpm db:push' to run migrations"
    Write-Host "  4. Visit http://localhost:3000 to see the application"
    Write-Host ""
    exit 0
} else {
    Write-Host "❌ Some checks failed. Please review the output above." -ForegroundColor Red
    Write-Host ""
    exit 1
}
