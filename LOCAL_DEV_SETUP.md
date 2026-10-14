# Local Development Setup - Accurate Configuration

**Last Updated:** March 17, 2026  
**Status:** Corrects errors in `SETUP_GUIDE.md`

---

## ⚠️ Important: Database Requirement

The VA Dashboard currently supports **MySQL only** for both local development and production. The `SETUP_GUIDE.md` claim that "SQLite is for local dev" is **FALSE**. This document provides accurate setup instructions.

---

## Prerequisites

Before starting, ensure you have:

- **Node.js** v22.13.0 or higher
- **pnpm** package manager
- **Git** for version control
- **MySQL Server** (local or remote) - **REQUIRED** (not optional)
- **Trello API credentials** (API Key + Token)

---

## Step 1: Clone and Install

```bash
# Navigate to project directory
cd /path/to/va-dashboard

# Install dependencies
pnpm install
```

---

## Step 2: Create Environment File

Create a `.env` file in the project root by copying `[.env.example](/d:/projects/VA dashboard/va-dashboard/.env.example)`, then fill in your local secrets.

### Option A: Local MySQL Server

```env
# Database - Local MySQL
DATABASE_URL=mysql://root:password@localhost:3306/va_dashboard

# Trello API Credentials (REQUIRED)
TRELLO_API_KEY=your_trello_api_key_here
TRELLO_TOKEN=your_trello_token_here

# JWT Secret (for authentication)
JWT_SECRET=your_random_secret_here_min_32_chars

# OAuth (Manus OAuth)
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://portal.manus.im
VITE_APP_ID=va-dashboard

# Owner Info (your Trello user)
OWNER_NAME=Your Name
OWNER_OPEN_ID=your_trello_user_id

# Frontend Config
VITE_APP_TITLE=VA Task Dashboard
VITE_APP_LOGO=/logo.png

# Built-in Forge API (for LLM, storage, etc.)
BUILT_IN_FORGE_API_URL=https://forge.manus.ai
BUILT_IN_FORGE_API_KEY=your_forge_api_key

# Frontend Forge API (for client-side access)
VITE_FRONTEND_FORGE_API_URL=https://forge.manus.ai
VITE_FRONTEND_FORGE_API_KEY=your_frontend_forge_api_key
```

### Option B: Remote MySQL Server (Cloud)

```env
# Database - Remote MySQL (e.g., AWS RDS, DigitalOcean)
DATABASE_URL=mysql://username:password@your-host.rds.amazonaws.com:3306/va_dashboard

# ... rest of variables same as Option A
```

### Option C: Docker MySQL (Recommended for Local Dev)

```bash
# Start MySQL in Docker
docker run --name va-mysql \
  -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=va_dashboard \
  -p 3306:3306 \
  -d mysql:9.7.2

# Use in .env
DATABASE_URL=mysql://root:rootpass@localhost:3306/va_dashboard
```

---

## Step 3: Database Setup

```bash
# Generate migrations and push schema to database
pnpm db:push

# This will:
# 1. Generate migration files from schema.ts
# 2. Run migrations against your MySQL database
# 3. Create all 58 tables
```

**If you get "Table doesn't exist" errors:**
```bash
# Force regenerate and migrate
pnpm db:push --force
```

---

## Step 4: Get Trello Credentials

1. Visit https://trello.com/app-key
2. Copy your **API Key**
3. Click "Token" and authorize the app
4. Copy your **Token**
5. Visit https://trello.com/1/members/me?key=YOUR_API_KEY&token=YOUR_TOKEN
6. Copy your **User ID** (the `id` field)

Add these to your `.env` file:
```env
TRELLO_API_KEY=abc123...
TRELLO_TOKEN=xyz789...
OWNER_OPEN_ID=user_id_from_api
```

---

## Step 5: Start Development Server

```bash
# Start dev server (watches for changes)
pnpm dev

# Server runs on http://localhost:3000
# Frontend: http://localhost:3000
# API: http://localhost:3000/api/trpc
```

---

## Step 6: Verify Setup

Visit http://localhost:3000 in your browser and check:

- ✅ Page loads (no 500 errors)
- ✅ Login button appears
- ✅ Can log in with Manus OAuth
- ✅ Dashboard loads with tasks
- ✅ No console errors (except expected 401 auth errors)

---

## Troubleshooting

### "Table doesn't exist" Error

**Cause:** Migrations haven't run yet.

**Fix:**
```bash
pnpm db:push
```

### "Connection refused" Error

**Cause:** MySQL server not running or wrong credentials.

**Fix:**
```bash
# Check MySQL is running
mysql -u root -p -h localhost -e "SELECT 1;"

# If using Docker
docker ps | grep mysql
docker logs va-mysql
```

### "ECONNREFUSED 127.0.0.1:3306"

**Cause:** MySQL not listening on localhost:3306.

**Fix:**
```bash
# For local MySQL, check it's running
sudo systemctl start mysql

# For Docker
docker start va-mysql

# For remote, verify DATABASE_URL is correct
```

### "Invalid connection string"

**Cause:** DATABASE_URL format is wrong.

**Fix:** Ensure it matches:
```
mysql://username:password@host:port/database
```

### "Unknown database 'va_dashboard'"

**Cause:** Database doesn't exist yet.

**Fix:**
```bash
# Create database manually
mysql -u root -p -e "CREATE DATABASE va_dashboard;"

# Then run migrations
pnpm db:push
```

### Dev Server Won't Start

**Cause:** Port 3000 already in use or missing dependencies.

**Fix:**
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Reinstall dependencies
rm -rf node_modules pnpm-lock.yaml
pnpm install

# Start again
pnpm dev
```

---

## Environment Variables Reference

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `DATABASE_URL` | ✅ Yes | MySQL connection string | `mysql://root:pass@localhost/va_dashboard` |
| `TRELLO_API_KEY` | ✅ Yes | Trello API authentication | `abc123...` |
| `TRELLO_TOKEN` | ✅ Yes | Trello API authentication | `xyz789...` |
| `JWT_SECRET` | ✅ Yes | Session cookie signing | `random_string_32_chars_min` |
| `OAUTH_SERVER_URL` | ✅ Yes | Manus OAuth server | `https://api.manus.im` |
| `VITE_OAUTH_PORTAL_URL` | ✅ Yes | Manus login portal | `https://portal.manus.im` |
| `VITE_APP_ID` | ✅ Yes | OAuth app ID | `va-dashboard` |
| `OWNER_NAME` | ✅ Yes | Owner's display name | `Your Name` |
| `OWNER_OPEN_ID` | ✅ Yes | Owner's Trello user ID | `user_id_from_trello_api` |
| `VITE_APP_TITLE` | ✅ Yes | App title in UI | `VA Task Dashboard` |
| `VITE_APP_LOGO` | ✅ Yes | Logo path | `/logo.png` |
| `BUILT_IN_FORGE_API_URL` | ✅ Yes | Manus Forge API | `https://forge.manus.ai` |
| `BUILT_IN_FORGE_API_KEY` | ✅ Yes | Forge API key | `key_...` |
| `VITE_FRONTEND_FORGE_API_URL` | ✅ Yes | Frontend Forge API | `https://forge.manus.ai` |
| `VITE_FRONTEND_FORGE_API_KEY` | ✅ Yes | Frontend Forge key | `key_...` |

---

## SQLite Support (Future)

**Current Status:** SQLite is NOT supported. The system is MySQL-only.

**Future Plan:** Support for SQLite is planned but not yet implemented. When added, it will require:
1. Updating `drizzle.config.ts` to auto-detect database type
2. Adding SQLite driver to dependencies
3. Testing all migrations with SQLite
4. Updating this guide

**For now:** Use MySQL only.

---

## Next Steps

1. ✅ Set up `.env` file
2. ✅ Run `pnpm db:push`
3. ✅ Run `pnpm dev`
4. ✅ Visit http://localhost:3000
5. ✅ Log in with Manus OAuth
6. ✅ Verify tasks load from Trello

---

## Additional Resources

- **Database Schema:** See `drizzle/schema.ts`
- **Environment Template:** See `[.env.example](/d:/projects/VA dashboard/va-dashboard/.env.example)`
- **API Endpoints:** See `server/routers.ts`
- **Architecture:** See `ARCHITECTURE-ACTUAL.md`
- **Project Status:** See `todo.md`
- **Documentation Authority:** See `DOCUMENTATION-AUTHORITY.md`
