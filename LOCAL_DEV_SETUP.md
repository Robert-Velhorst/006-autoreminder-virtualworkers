# Local Development

## Requirements

- Node.js 24.21.0 (see `Dockerfile`)
- pnpm 12.11.2 (see `package.json`)
- PostgreSQL reachable from the development process

## Setup

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Create a local `.env` based on `.env.example`.
3. Set `DATABASE_URL` to the PostgreSQL development database and configure a random local `JWT_SECRET`.
4. Apply migrations with `pnpm db:migrate`.
5. Run `pnpm dev` and open the local URL printed by Vite.

Use a separate, disposable PostgreSQL database for tests. Never point tests or schema experiments at production data. The application can run without Redis using a process-local cache; configure `REDIS_URL` only when testing shared cache or realtime behavior.

## Useful checks

```sh
pnpm check
pnpm test
pnpm build
```

`pnpm db:generate` always generates PostgreSQL migrations under `drizzle-postgres-v1/`; review generated SQL before applying it. `DATABASE_URL` must be a PostgreSQL URL. Legacy MySQL schema and transfer scripts are not supported by the application runtime. Full MySQL-to-PostgreSQL data transfer remains incomplete; see [Production Cutover](docs/PRODUCTION_CUTOVER.md).
