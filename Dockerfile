# Multi-stage build for VA Dashboard. Dependencies are installed once and the
# resulting layer is shared by build, migration, and production-prune stages.
FROM node:22-alpine AS dependencies

RUN npm install -g pnpm@11.19.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM node:22-alpine AS production
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
WORKDIR /app

COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs --from=builder /app/dist ./dist
COPY --chown=nodejs:nodejs --from=builder /app/drizzle ./drizzle
COPY --chown=nodejs:nodejs --from=builder /app/shared ./shared
COPY --chown=nodejs:nodejs drizzle.config.ts ./
COPY --chown=nodejs:nodejs scripts/run-migrations.mjs ./scripts/run-migrations.mjs

USER nodejs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health/ready', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]
