# VA Dashboard - Quick Start Guide

Get the VA Dashboard up and running in minutes!

## 🚀 Quick Start (Docker - Recommended)

The fastest way to get started is using Docker Compose:

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd va-dashboard

# 2. Copy environment file
cp .env.example .env

# 3. Edit .env with your Trello credentials
nano .env  # or use your favorite editor

# 4. Start all services
docker-compose up -d

# 5. Run database migrations
docker-compose exec app pnpm db:push

# 6. Open your browser
open http://localhost:3000
```

That's it! The application is now running with MySQL and Redis.

## 🛠️ Manual Setup (Without Docker)

If you prefer to run services manually:

### Prerequisites
- Node.js 24.21.0 LTS
- pnpm 12.11.2
- MySQL 8.4.12 LTS
- Redis 8.10.2 (optional but recommended)

### Step 1: Install Dependencies
```bash
pnpm install
```

### Step 2: Set Up MySQL
```bash
# Option A: Using Docker
docker run --name va-mysql \
  -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=va_dashboard \
  -p 3306:3306 \
  -d mysql:8.0

# Option B: Using local MySQL
mysql -u root -p
CREATE DATABASE va_dashboard;
```

### Step 3: Set Up Redis (Optional)
```bash
# Using Docker
docker run --name va-redis \
  -p 6379:6379 \
  -d redis:7-alpine

# Or install locally
# macOS: brew install redis && redis-server
# Ubuntu: sudo apt install redis-server && sudo systemctl start redis
```

### Step 4: Configure Environment
```bash
cp .env.example .env
nano .env
```

**Minimum required variables:**
```bash
DATABASE_URL=mysql://root:rootpass@localhost:3306/va_dashboard
TRELLO_API_KEY=your_trello_api_key
TRELLO_TOKEN=your_trello_token
JWT_SECRET=your_random_secret_min_32_chars
OWNER_OPEN_ID=your_trello_user_id
```

### Step 5: Run Migrations
```bash
pnpm db:push
```

### Step 6: Start Development Server
```bash
pnpm dev
```

The application will be available at http://localhost:3000

## 🔑 Getting Trello Credentials

1. **Get API Key:**
   - Visit https://trello.com/app-key
   - Copy your API Key

2. **Get Token:**
   - On the same page, click "Token" link
   - Authorize the application
   - Copy the token

3. **Get Your User ID:**
   - Visit https://trello.com/1/members/me?key=YOUR_API_KEY&token=YOUR_TOKEN
   - Copy the `id` field

## 📋 First Time Setup

### Create Your First User

The application uses local authentication. On first visit:

1. You'll see a login form
2. Click "Register" (if available) or use the default admin account
3. Login with your credentials

### Connect to Trello

1. Go to Settings
2. Verify Trello credentials are configured
3. The app will automatically sync your boards

### Configure Working Hours

1. Go to Settings → Working Hours
2. Set your work start/end times
3. Configure break times
4. Select working days
5. Save changes

## 🧪 Running Tests

```bash
# Unit tests
pnpm test

# E2E tests (requires app to be running)
pnpm test:e2e

# E2E tests with UI
pnpm test:e2e:ui

# Watch mode for development
pnpm test:watch
```

## 🐛 Troubleshooting

### Port Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use a different port
PORT=3001 pnpm dev
```

### Database Connection Error
```bash
# Check MySQL is running
docker ps  # if using Docker
mysql -u root -p  # test connection

# Verify DATABASE_URL in .env
echo $DATABASE_URL
```

### Redis Connection Error
```bash
# Redis is optional, app will work without it
# To check if Redis is running:
redis-cli ping  # should return PONG

# If not running:
docker start va-redis  # if using Docker
redis-server  # if installed locally
```

### Trello API Errors
```bash
# Verify credentials
curl "https://api.trello.com/1/members/me?key=YOUR_KEY&token=YOUR_TOKEN"

# Should return your Trello user info
```

### Build Errors
```bash
# Clear cache and reinstall
rm -rf node_modules .pnpm-store
pnpm install

# Clear build artifacts
rm -rf dist .vite

# Rebuild
pnpm build
```

## 📚 Common Tasks

### View Logs
```bash
# Docker
docker-compose logs -f app

# Manual setup
# Logs are output to console
```

### Restart Services
```bash
# Docker
docker-compose restart app

# Manual setup
# Stop (Ctrl+C) and run pnpm dev again
```

### Update Database Schema
```bash
# After modifying drizzle/schema.ts
pnpm db:push
```

### Clear Cache
```bash
# Via API
curl -X POST http://localhost:3000/api/cache/invalidate

# Or restart the application
```

### Backup Database
```bash
# Docker
docker-compose exec mysql mysqldump -u root -p va_dashboard > backup.sql

# Manual
mysqldump -u root -p va_dashboard > backup.sql
```

### Restore Database
```bash
# Docker
docker-compose exec -T mysql mysql -u root -p va_dashboard < backup.sql

# Manual
mysql -u root -p va_dashboard < backup.sql
```

## 🎯 Next Steps

1. **Explore the Dashboard**
   - View your tasks from Trello
   - Check the timeline view
   - Try completing a task

2. **Configure Settings**
   - Set up working hours
   - Add holidays
   - Configure notifications

3. **Try ATIS Analysis**
   - Go to ATIS Phases page
   - Select a task
   - Run analysis to see AI-powered insights

4. **Manage Workers**
   - Add virtual assistants
   - Assign tasks
   - Track progress

5. **Generate APTLSS Checklists**
   - Go to APTLSS Management
   - Select cards
   - Generate checklists

## 📖 Documentation

- **Full Setup:** See `LOCAL_DEV_SETUP.md`
- **Deployment:** See `DEPLOYMENT.md`
- **Architecture:** See `ARCHITECTURE-ACTUAL.md`
- **Improvements:** See `IMPROVEMENTS_SUMMARY.md`
- **API Docs:** See `docs/` folder

## 🆘 Getting Help

1. **Check Logs:** Most issues are visible in logs
2. **Review Documentation:** Check the docs folder
3. **GitHub Issues:** Search existing issues
4. **Health Check:** Visit http://localhost:3000/api/health

## 🎉 Success!

If you see the dashboard and can view your Trello tasks, you're all set!

**Happy task managing! 🚀**
