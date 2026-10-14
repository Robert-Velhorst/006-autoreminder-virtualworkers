# Environment Variables Setup Guide

**Last Updated:** March 18, 2026  
**Status:** Complete reference for all required environment variables

---

## Quick Reference

The following environment variables are **REQUIRED** to run the VA Dashboard locally:

```env
# Database (MySQL only, not SQLite)
DATABASE_URL=mysql://root:password@localhost:3306/va_dashboard

# Trello API
TRELLO_API_KEY=your_api_key
TRELLO_TOKEN=your_token

# Authentication
JWT_SECRET=your_random_secret_min_32_chars

# Manus OAuth
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://portal.manus.im
VITE_APP_ID=va-dashboard

# Owner Info
OWNER_NAME=Your Name
OWNER_OPEN_ID=your_trello_user_id

# Frontend Config
VITE_APP_TITLE=VA Task Dashboard
VITE_APP_LOGO=/logo.png

# Manus Forge API
BUILT_IN_FORGE_API_URL=https://forge.manus.ai
BUILT_IN_FORGE_API_KEY=your_forge_api_key
VITE_FRONTEND_FORGE_API_URL=https://forge.manus.ai
VITE_FRONTEND_FORGE_API_KEY=your_frontend_forge_api_key
```

The repository now includes a root `[.env.example](/d:/projects/VA dashboard/va-dashboard/.env.example)` file with the same baseline values and placeholders.

---

## Detailed Setup Instructions

### 1. DATABASE_URL (MySQL Connection)

**Required:** Yes  
**Format:** `mysql://username:password@host:port/database`

**Options:**

**Option A: Local MySQL Server**
```env
DATABASE_URL=mysql://root:your_password@localhost:3306/va_dashboard
```

**Option B: Docker MySQL (Recommended)**
```bash
# Start MySQL container
docker run --name va-mysql \
  -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=va_dashboard \
  -p 3306:3306 \
  -d mysql:9.7.2

# Then use in .env:
DATABASE_URL=mysql://root:rootpass@localhost:3306/va_dashboard
```

**Option C: Remote MySQL (AWS RDS, DigitalOcean, etc.)**
```env
DATABASE_URL=mysql://username:password@your-host.rds.amazonaws.com:3306/va_dashboard
```

**Verify Connection:**
```bash
mysql -u root -p -h localhost -e "SELECT 1;"
```

---

### 2. TRELLO_API_KEY & TRELLO_TOKEN

**Required:** Yes  
**Source:** https://trello.com/app-key

**Steps to Obtain:**

1. Visit https://trello.com/app-key
2. Copy the **API Key** value
3. Click the **Token** link to generate a token
4. Copy the **Token** value
5. Add to `.env`:
   ```env
   TRELLO_API_KEY=abc123xyz...
   TRELLO_TOKEN=def456uvw...
   ```

**Verify:**
```bash
curl "https://api.trello.com/1/members/me?key=YOUR_API_KEY&token=YOUR_TOKEN"
```

---

### 3. JWT_SECRET

**Required:** Yes  
**Purpose:** Signs session cookies for authentication  
**Length:** Minimum 32 characters

**Generate:**
```bash
# Using openssl
openssl rand -base64 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Using Python
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**Example:**
```env
JWT_SECRET=<generate-a-unique-random-secret>
```

---

### 4. OAUTH_SERVER_URL & VITE_OAUTH_PORTAL_URL

**Required:** Yes  
**Purpose:** Manus OAuth endpoints  
**Use these values:**

```env
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://portal.manus.im
VITE_APP_ID=va-dashboard
```

These are fixed values for the Manus platform.

---

### 5. OWNER_NAME & OWNER_OPEN_ID

**Required:** Yes  
**Purpose:** Identifies the app owner in the system

**OWNER_NAME:** Your display name (any string)
```env
OWNER_NAME=John Doe
```

**OWNER_OPEN_ID:** Your Trello user ID

**To get OWNER_OPEN_ID:**
```bash
# After getting TRELLO_API_KEY and TRELLO_TOKEN, run:
curl "https://api.trello.com/1/members/me?key=YOUR_API_KEY&token=YOUR_TOKEN"

# Look for the "id" field in the JSON response:
# {
#   "id": "5f7a1b2c3d4e5f6a7b8c9d0e",
#   "username": "your_username",
#   ...
# }

# Use that id value:
OWNER_OPEN_ID=5f7a1b2c3d4e5f6a7b8c9d0e
```

---

### 6. VITE_APP_TITLE & VITE_APP_LOGO

**Required:** Yes  
**Purpose:** Frontend branding

**VITE_APP_TITLE:** Title shown in browser tab and header
```env
VITE_APP_TITLE=VA Task Dashboard
```

**VITE_APP_LOGO:** Path to logo file (relative to `/client/public/`)
```env
VITE_APP_LOGO=/logo.png
```

Place your logo file at `/client/public/logo.png`

---

### 7. BUILT_IN_FORGE_API_URL & BUILT_IN_FORGE_API_KEY

**Required:** Yes  
**Purpose:** Manus built-in APIs (LLM, storage, notifications, etc.)

**Obtain from:** Manus support or dashboard

```env
BUILT_IN_FORGE_API_URL=https://forge.manus.ai
BUILT_IN_FORGE_API_KEY=key_xxxxxxxxxxxxxxxx
```

---

### 8. VITE_FRONTEND_FORGE_API_URL & VITE_FRONTEND_FORGE_API_KEY

**Required:** Yes  
**Purpose:** Frontend-accessible Forge API (for client-side operations)

```env
VITE_FRONTEND_FORGE_API_URL=https://forge.manus.ai
VITE_FRONTEND_FORGE_API_KEY=key_xxxxxxxxxxxxxxxx
```

---

### 9. SENDGRID_API_KEY (Optional)

**Required:** No  
**Purpose:** Email notifications

If you want to enable email notifications:
1. Sign up at https://sendgrid.com
2. Get your API key from Settings > API Keys
3. Add to `.env`:
   ```env
   SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxx
   ```

Leave blank to disable email functionality.

---

### 10. Analytics Variables (Optional)

**Required:** No  
**Purpose:** Usage tracking

```env
VITE_ANALYTICS_ENDPOINT=https://analytics.example.com
VITE_ANALYTICS_WEBSITE_ID=your_website_id
```

Leave blank to disable analytics.

---

## Setup Checklist

Before running `pnpm dev`:

- [ ] MySQL server is running
- [ ] `.env` file created from `[.env.example](/d:/projects/VA dashboard/va-dashboard/.env.example)`
- [ ] `DATABASE_URL` is correct and database exists
- [ ] `TRELLO_API_KEY` and `TRELLO_TOKEN` are valid
- [ ] `JWT_SECRET` is at least 32 characters
- [ ] `OWNER_OPEN_ID` matches your Trello user ID
- [ ] All REQUIRED variables are filled in (not blank)

---

## Running the Application

```bash
# 1. Install dependencies
pnpm install

# 2. Create database tables
pnpm db:push

# 3. Start development server
pnpm dev

# 4. Open browser
# Visit http://localhost:3000
```

---

## Troubleshooting

### "ECONNREFUSED" - MySQL Connection Error

**Cause:** MySQL server not running

**Fix:**
```bash
# Check if MySQL is running
mysql -u root -p -h localhost -e "SELECT 1;"

# If not running, start it:
# macOS (Homebrew)
brew services start mysql

# Linux
sudo systemctl start mysql

# Docker
docker start va-mysql
```

### "Unknown database 'va_dashboard'"

**Cause:** Database doesn't exist

**Fix:**
```bash
# Create database
mysql -u root -p -e "CREATE DATABASE va_dashboard;"

# Then run migrations
pnpm db:push
```

### "Invalid connection string"

**Cause:** DATABASE_URL format is wrong

**Fix:** Ensure format is:
```
mysql://username:password@host:port/database
```

### "Trello API Error: invalid key"

**Cause:** TRELLO_API_KEY is invalid or expired

**Fix:**
1. Visit https://trello.com/app-key
2. Regenerate API key
3. Update `.env`

### "Port 3000 already in use"

**Cause:** Another process is using port 3000

**Fix:**
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or use a different port
PORT=3001 pnpm dev
```

---

## Environment Variables Reference Table

| Variable | Required | Type | Example |
|----------|----------|------|---------|
| `DATABASE_URL` | ✅ | String | `mysql://root:pass@localhost/va_dashboard` |
| `TRELLO_API_KEY` | ✅ | String | `abc123...` |
| `TRELLO_TOKEN` | ✅ | String | `xyz789...` |
| `JWT_SECRET` | ✅ | String | `a7f3k9m2x8q1w5r4t6y9u2i3o4p5l6k7` |
| `OAUTH_SERVER_URL` | ✅ | URL | `https://api.manus.im` |
| `VITE_OAUTH_PORTAL_URL` | ✅ | URL | `https://portal.manus.im` |
| `VITE_APP_ID` | ✅ | String | `va-dashboard` |
| `OWNER_NAME` | ✅ | String | `John Doe` |
| `OWNER_OPEN_ID` | ✅ | String | `5f7a1b2c3d4e5f6a7b8c9d0e` |
| `VITE_APP_TITLE` | ✅ | String | `VA Task Dashboard` |
| `VITE_APP_LOGO` | ✅ | String | `/logo.png` |
| `BUILT_IN_FORGE_API_URL` | ✅ | URL | `https://forge.manus.ai` |
| `BUILT_IN_FORGE_API_KEY` | ✅ | String | `key_...` |
| `VITE_FRONTEND_FORGE_API_URL` | ✅ | URL | `https://forge.manus.ai` |
| `VITE_FRONTEND_FORGE_API_KEY` | ✅ | String | `key_...` |
| `SENDGRID_API_KEY` | ❌ | String | `SG.xxx...` |
| `VITE_ANALYTICS_ENDPOINT` | ❌ | URL | `https://analytics.example.com` |
| `VITE_ANALYTICS_WEBSITE_ID` | ❌ | String | `website_id` |

---

## Additional Resources

- **Local Dev Setup:** See `LOCAL_DEV_SETUP.md`
- **Environment Template:** See `[.env.example](/d:/projects/VA dashboard/va-dashboard/.env.example)`
- **Database Schema:** See `drizzle/schema.ts`
- **API Endpoints:** See `server/routers.ts`
- **Architecture:** See `ARCHITECTURE-ACTUAL.md`
- **Project Status:** See `todo.md`
