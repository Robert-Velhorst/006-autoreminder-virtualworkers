import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    hookTimeout: 125_000,
    environment: "node",
    include: [
      "client/src/pages/worker/WorkerOperator.presentation.test.tsx",
      "client/src/_core/hooks/useAuth.test.tsx",
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
