import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: [
      "client/src/pages/worker/WorkerOperator.presentation.test.tsx",
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "scripts/operator-data-transfer-ownership.test.mjs",
      "scripts/aptlss-pilot-validation.test.mjs",
      "scripts/run-mysql-integration.test.mjs",
      "scripts/operational-record-fingerprint.test.mjs",
      "scripts/operational-record-fingerprint.integration.test.mjs",
      "scripts/full-data-rollback-checkpoint.test.mjs",
      "scripts/full-data-rollback-checkpoint.integration.test.mjs",
      "scripts/verify-production-image.test.mjs",
      "scripts/verify-generated-records.test.mjs",
      "scripts/pilot-backup-restore.test.mjs",
      "scripts/pilot-backup-restore.integration.test.mjs",
      "scripts/pilot-database-backup.test.mjs",
      "scripts/pilot-migration-ledger.test.mjs",
    ],
  },
});
