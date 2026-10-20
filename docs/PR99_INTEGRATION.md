# APTLSS shadow-pilot integration

This source integration retains the manager/evidence/reminder feature work while preserving main's canonical PostgreSQL pool, verified TLS, current dependency pins, public-origin checks, webhook validation and deployment configuration.

The original MySQL pilot history remains in Git for provenance. Its historical verification reports do not prove acceptance of this PostgreSQL integration. New PostgreSQL schema/migration and query acceptance, browser behavior, provider permissions and activation must be verified independently. No live provider action, deployment or user database migration was performed by this consolidation task.

Current validation is in progress; this document is not a production acceptance declaration.

Hosted PostgreSQL 18.6 has applied the appended migration chain and passed complete runtime table/column parity. A first real database test run passed 3,467 assertions and exposed remaining fixture/transfer compatibility issues; those corrections are committed for a fresh run. Final database, browser, source-attestation and container gates remain required before merge. The dependency audit reports no known vulnerabilities after the selector-parser patch.
