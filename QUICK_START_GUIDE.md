# Quick Start

The VA Dashboard uses PostgreSQL. Provision a development database first; this repository's Docker Compose file starts only the application container.

```sh
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env`, set `DATABASE_URL` to your PostgreSQL instance, and provide a local `JWT_SECRET`. Then run:

```sh
pnpm db:migrate
pnpm dev
```

The development server prints its local URL. To run the app in its single Docker container instead, configure `.env` so the container can reach PostgreSQL, then use `docker compose up -d --build`.

Useful validation commands:

```sh
pnpm check
pnpm test
pnpm build
```

Production setup, access controls, backup requirements, and the still-incomplete legacy MySQL data transfer are documented in [DEPLOYMENT.md](DEPLOYMENT.md) and [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md). Do not use production data for local tests.
