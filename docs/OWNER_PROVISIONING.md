# First Owner Provisioning

Run this operator-only command from a trusted host after applying PostgreSQL migrations. It does not enable public registration or create a worker profile.

Supply `DATABASE_URL`, `OWNER_BOOTSTRAP_OPEN_ID`, and `OWNER_BOOTSTRAP_TOKEN` through the private process environment. The database must be privately reachable; the token must contain at least 24 characters. Never put these values in command arguments, source control, or public issue comments.

Preview first, replacing the example username with the exact configured open ID:

```sh
pnpm owner:provision --username owner --name "Owner" --dry-run
```

After reviewing the preview, use `--execute` instead of `--dry-run`. Complete the existing one-time owner setup UI using the configured token. An existing account is not promoted or reset; conflicting identities and other administrators cause the command to refuse changes. Repeating the command for the exact same pending owner is harmless.

The command defaults to dry run. Unit tests cover validation and transaction behavior. The separate PostgreSQL integration tests require an isolated test database; no production provisioning or database acceptance is implied by the unit tests.
