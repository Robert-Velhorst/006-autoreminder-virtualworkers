# Multi-stage build for VA Dashboard
# Stage 1: Build frontend and backend
FROM node:26.12.0-alpine AS builder

# Install pnpm
RUN npm install -g pnpm@12.14.0

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build frontend and backend
RUN pnpm build

# Stage 2: Install only runtime dependencies
FROM node:26.12.0-alpine AS production-deps

RUN npm install -g pnpm@12.14.0

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod

# Stage 3: Minimal production image
FROM node:26.12.0-alpine AS production

# Refresh the runtime library patch; installation tools stay in earlier stages.
RUN apk upgrade --no-cache zlib && \
    rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOCAL_AUTH_BYPASS=false

# Keep package.json for Node's ESM package scope; the package manager and
# dependency manifests are not needed at runtime.
COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs --from=production-deps /app/node_modules ./node_modules

# Copy built artifacts from builder
COPY --chown=nodejs:nodejs --from=builder /app/dist ./dist
COPY --chown=nodejs:nodejs --from=builder /app/drizzle ./drizzle
COPY --chown=nodejs:nodejs --from=builder /app/shared ./shared

# Copy necessary runtime files
COPY --chown=nodejs:nodejs drizzle.config.ts ./

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "dist/index.js"]
