# Hetzner deployment

The supported runtime uses external PostgreSQL with certificate and hostname
verification. Follow [the current deployment guide](../DEPLOYMENT.md),
[production cutover](PRODUCTION_CUTOVER.md), and the checked release scripts in
`deployment/hetzner/`. The previous branch-only MySQL/Redis Compose alternative
is retired; do not use it for this PostgreSQL release.

Before any cutover, inventory the actual host, data, credentials, backups,
restore procedure and consumers. Prove migration and rollback on the intended
target before retiring existing services. A repository merge or published
container does not prove a live deployment, data transfer, credential rotation,
or operator acceptance.
