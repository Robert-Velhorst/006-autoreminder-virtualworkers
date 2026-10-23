import { build } from 'esbuild';

await build({
  entryPoints: ['scripts/test-codex-shared-transport.ts'],
  platform: 'node', bundle: true, format: 'esm', outfile: 'dist/test-codex-shared-transport.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
