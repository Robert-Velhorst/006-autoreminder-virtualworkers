# Environment Setup

The supported application database is PostgreSQL. Copy `.env.example` to `.env` and configure only the providers and features you use. Never commit `.env` or put secrets in client-side `VITE_*` variables.

## Required database setting

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

Percent-encode reserved characters in the username or password. For a local PostgreSQL server used by the Node development process, `HOST` is usually `localhost`. For Docker Compose connecting to PostgreSQL on the Docker host, use `host.docker.internal`; for production, prefer the database's private hostname and TLS configuration.

Apply schema migrations from a trusted administration environment:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
```

The PostgreSQL schema is `drizzle/schema.postgres.ts`, with migration files in `drizzle-postgres-v1/`. The MySQL schema/migration lineage is legacy and must not be applied to the PostgreSQL runtime.

## Authentication and integrations

Set a unique, random `JWT_SECRET` with at least 32 characters. Keep `LOCAL_AUTH_BYPASS=false` outside loopback development. Add Trello, email, or AI provider credentials only when enabling those integrations. Store production values in the host's secret manager rather than a checked-in file.

`REDIS_URL` is optional; without it, the application uses its process-local cache. Compose starts only the app container, so any Redis service must be provisioned separately if shared cache/realtime coordination is needed.

See [.env.example](.env.example) for the current variable names, [README.md](README.md) for local usage, and [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment. The operator data-transfer utility is not yet a complete MySQL-to-PostgreSQL migration tool; do not use it for a production cutover.
