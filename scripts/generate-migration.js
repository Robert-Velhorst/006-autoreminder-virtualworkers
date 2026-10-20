import { spawn } from 'child_process';

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const applyMigration = process.argv.includes('--apply');

function runDrizzle(args, options = {}) {
  return spawn(packageManager, ['exec', 'drizzle-kit', ...args], {
    shell: false,
    ...options,
  });
}

const child = runDrizzle(['generate'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(data);

  if (output.includes('created or renamed from another column?')) {
    console.log('\n[Migration] Accepting the default create-column choice. Review the generated SQL before applying it.');
    child.stdin.write('\n');
  }
});

child.on('close', (code) => {
  console.log(`\ndrizzle-kit generate exited with code ${code}`);
  if (code !== 0) {
    process.exit(code ?? 1);
    return;
  }

  if (!applyMigration) {
    console.log('Migration generated but not applied. Re-run with --apply after reviewing the generated SQL.');
    return;
  }

  console.log('Applying reviewed migration...');
  const migrateChild = runDrizzle(['migrate'], { stdio: 'inherit' });
  migrateChild.on('close', (migrateCode) => {
    console.log(`drizzle-kit migrate exited with code ${migrateCode}`);
    process.exit(migrateCode ?? 1);
  });
});
