import { test } from 'node:test';
import assert from 'node:assert/strict';
import superjson from 'superjson';
import { assertApplicationRolePrivileges, configureApplicationRole, verifyPostgresProductionImage } from './verify-postgres-production-image.mjs';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const PG = `sha256:${'b'.repeat(64)}`;
const ok = stdout => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
const absent = type => ({ status: 1, stdout: '', stderr: `Error: No such ${type}` });
const valueAfter = (args, name) => args[args.indexOf(name) + 1];
function fixture(options = {}) {
  const commands = [], requests = [], files = new Map(), removed = [], closed = [];
  const networks = new Map(), containers = new Map();
  let prepared, offboarded = false, clock = 0;
  const founder = { id: 1, openId: 'fixture-founder', role: 'admin' };
  const worker = { id: 2, openId: 'fixture-worker', role: 'worker' };
  const run = (program, args, limits) => {
    commands.push({ program, args, limits });
    const injected = options.command?.({ program, args, networks, containers });
    if (injected) return injected;
    if (program === 'openssl') return ok('');
    assert.equal(program, 'docker');
    if (args[0] === 'context') return ok([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    if (args[0] === 'image') return ok([{ Id: args[2] === 'postgres:18.6' ? PG : IMAGE, Os: 'linux',
      Config: { Env: args[2] === 'postgres:18.6' ? ['PG_MAJOR=18', 'PG_VERSION=18.6-1'] : ['NODE_ENV=production'] } }]);
    if (args[1] === 'inspect') {
      const map = args[0] === 'network' ? networks : containers;
      return map.has(args[2]) ? ok([map.get(args[2])]) : absent(args[0]);
    }
    if (args[0] === 'network' && args[1] === 'create') {
      const name = args.at(-1), [key, value] = valueAfter(args, '--label').split('=');
      networks.set(name, { Id: `${name}-id`, Internal: args.includes('--internal'), Labels: { [key]: value } });
      if (options.networkCreateTimeout) return { error: new Error('private Docker details'), status: null };
      return ok(`${name}-id`);
    }
    if (args[0] === 'run') {
      const name = valueAfter(args, '--name'), [key, value] = valueAfter(args, '--label').split('=');
      const postgres = args.includes('--entrypoint');
      const internalPort = postgres ? 5432 : 3000;
      const tmpfs = {};
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--tmpfs') tmpfs[args[index + 1].split(':')[0]] = args[index + 1];
      }
      containers.set(name, { Id: `${name}-id`, Config: { Labels: { [key]: value } }, Image: postgres ? PG : IMAGE,
        State: { Running: true }, HostConfig: { Tmpfs: tmpfs }, Mounts: [],
        NetworkSettings: { Networks: { [valueAfter(args, '--network')]: {} },
          Ports: { [`${internalPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: postgres ? '41001' : '41002' }] } } });
      if ((postgres && options.postgresRunFailure) || (!postgres && options.appRunFailure)) return { status: 125, stdout: '', stderr: 'private startup details' };
      return ok(`${name}-id`);
    }
    if (args[1] === 'rm') {
      if (options.cleanupFailure) return { status: 1, stdout: '', stderr: 'private daemon details' };
      const map = args[0] === 'network' ? networks : containers;
      const entry = [...map].find(([, resource]) => resource.Id === args.at(-1));
      assert.ok(entry, 'Must remove an exact tracked resource ID');
      removed.push(entry[0]); map.delete(entry[0]);
      return ok('');
    }
    assert.fail(`Unexpected injected operation: ${program} ${args[0]}`);
  };
  const resources = {
    createTemp: () => '/tmp/va-pg-image-owned-test',
    mkdir: () => {}, chmod: () => {},
    write: (path, content) => { assert.ok(!files.has(path)); files.set(path, content); },
    removeTemp: path => {
      assert.equal(path, '/tmp/va-pg-image-owned-test');
      if (options.tempCleanupFailure) throw new Error('private filesystem detail');
      files.clear();
    },
    prepareDatabase: async args => {
      prepared = args;
      args.registerClose(async () => { closed.push(true); if (options.closeFailure) throw new Error('private database details'); });
      if (options.prepareFailure) throw new Error(`password=${args.password},${args.url}`);
      return { founder, worker, profileId: 3, schema: { tables: 138, migration: '0006_worker_session_lifecycle', migrationHash: 'c'.repeat(64) },
        verifyOffboard: async name => {
          assert.ok(offboarded); assert.match(name, /^image_acceptance_[a-f0-9-]+$/);
          assert.notEqual(new URL(args.url).searchParams.get('application_name'), name);
          if (options.offboardCommitFailure) throw new Error('private mutation details');
        } };
    },
  };
  const request = async args => {
    requests.push(args);
    const replacement = options.response?.(args);
    if (replacement) return replacement;
    if (args.path === '/api/health/ready') return { status: 200, json: { ready: true } };
    if (args.path === '/api/health/live') return { status: 200, json: { alive: true } };
    if (args.path === '/api/health') return { status: 200, json: { database: 'connected' } };
    if (args.path === '/api/auth/login') {
      assert.equal(args.body.password, prepared.password);
      if (offboarded && args.body.username === worker.openId) return { status: 403, json: {} };
      const token = args.body.username === founder.openId ? 'founder-token' : 'worker-token';
      return { status: 200, json: { success: true }, headers: { 'set-cookie': [`app_session_id=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`] } };
    }
    if (args.path === '/api/trpc/auth.me') {
      const user = args.cookie?.includes('founder-token') ? founder : args.cookie && !offboarded ? worker : null;
      return { status: 200, json: { result: { data: superjson.serialize(user) } } };
    }
    if (args.path === '/api/va/worker/profile') return offboarded
      ? { status: 401, json: {} }
      : { status: 200, json: { id: 3, userId: 2, status: 'active' } };
    if (args.path === '/api/va/vas') return { status: 403, json: {} };
    if (args.path === '/api/va/vas/3') {
      assert.equal(args.method, 'DELETE'); assert.equal(args.cookie, 'app_session_id=founder-token');
      offboarded = true;
      return { status: 200, json: { success: true } };
    }
    assert.fail(`Unexpected fixture request: ${args.path}`);
  };
  return { commands, requests, files, removed, closed, networks, containers, resources,
    get prepared() { return prepared; },
    dependencies: { env: { CI: 'true' }, platform: 'linux', run, resources, request,
      now: () => { clock += 61_000; return clock; }, sleep: async () => {} } };
}

test('requires explicit fixture authority and Linux before invoking any commands or resources', async () => {
  for (const change of [{ env: {} }, { env: { CI: 'false' } }, { platform: 'win32' },
    { env: { CI: 'true', DOCKER_HOST: 'tcp://production.invalid:2376' } }]) {
    const f = fixture();
    await assert.rejects(verifyPostgresProductionImage('candidate:test', { ...f.dependencies, ...change }));
    assert.equal(f.commands.length, 0); assert.equal(f.files.size, 0);
  }
});

test('explicit isolated-owned opt-in works without CI', async () => {
  const f = fixture();
  const result = await verifyPostgresProductionImage('candidate:test', { ...f.dependencies, env: { POSTGRES_IMAGE_ACCEPTANCE_FIXTURE: 'isolated-owned' } });
  assert.equal(result.passed, true);
});

test('passes only after exact-image, configured auth/offboarding checks and confirmed cleanup', async () => {
  const f = fixture();
  const result = await verifyPostgresProductionImage('candidate:mutable-tag', f.dependencies);
  assert.equal(result.imageId, IMAGE); assert.equal(result.postgresImageId, PG);
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.providerAcceptance, false);
  assert.equal(result.tables, 138); assert.equal(result.checks.includes('stale-session-denial'), true);
  assert.equal(f.closed.length, 1); assert.equal(f.files.size, 0);
  assert.equal(f.containers.size, 0); assert.equal(f.networks.size, 0);
  assert.match(f.removed[0], /-app$/); assert.match(f.removed[1], /-postgres$/); assert.match(f.removed[2], /-network$/);
  const runs = f.commands.filter(c => c.args[0] === 'run');
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args.at(-1), IMAGE);
  assert.equal(runs[0].args.includes(PG), true);
  assert.equal(f.commands.some(c => c.args.includes('pull') || c.args.includes('prune')), false);
});

test('uses internal owned networking, tmpfs PG18 data, dynamic loopback ports, and no existing database URL', async () => {
  const f = fixture();
  let pgEnv, appEnv;
  const write = f.resources.write;
  f.resources.write = (path, content) => { write(path, content); if (path.endsWith('postgres.env')) pgEnv = content; if (path.endsWith('app.env')) appEnv = content; };
  await verifyPostgresProductionImage('candidate:test', { ...f.dependencies,
    env: { CI: 'true', DATABASE_URL: 'postgresql://private:password@production.invalid/userdata' } });
  const create = f.commands.find(c => c.args[0] === 'network' && c.args[1] === 'create');
  assert.equal(create.args.includes('--internal'), true);
  const runs = f.commands.filter(c => c.args[0] === 'run');
  assert.equal(valueAfter(runs[0].args, '--publish'), '127.0.0.1::5432');
  assert.equal(valueAfter(runs[1].args, '--publish'), '127.0.0.1::3000');
  assert.equal(runs[0].args.includes('/var/lib/postgresql:rw,nosuid,nodev,size=768m'), true);
  assert.match(pgEnv, /^POSTGRES_DB=fixture_[a-f0-9]{32}$/m);
  assert.equal(appEnv.includes('production.invalid'), false);
  for (const field of ['BACKGROUND_JOBS_ENABLED=false', 'NOTIFICATIONS_ENABLED=false', 'LOCAL_AUTH_BYPASS=false', 'NODE_ENV=production', 'NODE_TLS_REJECT_UNAUTHORIZED=1']) {
    assert.equal(appEnv.includes(`${field}\n`), true);
  }
  assert.equal(appEnv.includes('APTLSS_TEST_DISABLE_BACKGROUND_JOBS'), false);
  assert.equal(f.commands.some(c => c.args.some(arg => arg.includes(f.prepared.password))), false);
});

test('binds verified TLS to both the loopback host and app DNS; never mounts the CA private key in a container', async () => {
  const f = fixture();
  let appEnv;
  const write = f.resources.write;
  f.resources.write = (path, content) => { write(path, content); if (path.endsWith('app.env')) appEnv = content; };
  await verifyPostgresProductionImage('candidate:test', f.dependencies);
  const hostUrl = new URL(f.prepared.url);
  assert.equal(hostUrl.hostname, '127.0.0.1'); assert.equal(hostUrl.port, '41001');
  assert.equal(hostUrl.searchParams.get('sslmode'), 'verify-full');
  assert.equal(hostUrl.searchParams.get('sslrootcert'), f.prepared.caPath);
  const appUrl = new URL(appEnv.split('\n').find(line => line.startsWith('DATABASE_URL=')).slice('DATABASE_URL='.length));
  assert.equal(appUrl.hostname, 'fixture-postgres'); assert.equal(appUrl.searchParams.get('sslmode'), 'verify-full');
  assert.equal(appUrl.searchParams.get('sslrootcert'), '/run/acceptance-ca.crt');
  assert.equal(hostUrl.username, 'fixture');
  assert.match(appUrl.username, /^app_[a-f0-9]{32}$/);
  assert.equal(appUrl.username, f.prepared.appRole);
  assert.equal(appUrl.password, f.prepared.appPassword);
  assert.notEqual(appUrl.password, hostUrl.password);
  const openssl = f.commands.filter(c => c.program === 'openssl');
  assert.equal(openssl.length, 3); assert.equal(openssl.every(c => c.limits.timeout === 20_000), true);
  const mounts = f.commands.filter(c => c.args[0] === 'run').map(c => valueAfter(c.args, '--mount'));
  assert.equal(mounts.every(mount => !mount.includes('/private') && mount.endsWith('readonly')), true);
  assert.match(f.prepared.migrationsFolder, /drizzle-postgres-v1$/);
});

test('does not operate on a remote Docker context', async () => {
  const f = fixture({ command: ({ args }) => args[0] === 'context'
    ? ok([{ Endpoints: { docker: { Host: 'ssh://production.invalid' } } }]) : undefined });
  await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /preflight/);
  assert.equal(f.commands.length, 1);
});

test('requires preloaded images and does not create resources if PG version is wrong', async () => {
  const f = fixture({ command: ({ args }) => args[0] === 'image' && args[2] === 'postgres:18.6'
    ? ok([{ Id: PG, Config: { Env: ['PG_MAJOR=17', 'PG_VERSION=17.9'] } }]) : undefined });
  await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /preflight/);
  assert.equal(f.files.size, 0);
});

for (const [name, options] of [
  ['ambiguous network creation', { networkCreateTimeout: true }],
  ['ambiguous PG startup', { postgresRunFailure: true }],
  ['canonical migration or seeding failure', { prepareFailure: true }],
  ['ambiguous app startup', { appRunFailure: true }],
]) {
  test(`cleans exactly owned resources after ${name}`, async () => {
    const f = fixture(options);
    await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /acceptance failed/);
    assert.equal(f.containers.size, 0); assert.equal(f.networks.size, 0); assert.equal(f.files.size, 0);
    assert.equal(f.removed.every(name => /^va-pg-image-[a-f0-9-]+-(app|postgres|network)$/.test(name)), true);
  });
}

for (const [name, response] of [
  ['readiness never succeeds', args => args.path === '/api/health/ready' ? { status: 503, json: { ready: false } } : undefined],
  ['health fails', args => args.path === '/api/health' ? { status: 503, json: {} } : undefined],
  ['offboarding reports failure', args => args.method === 'DELETE' ? { status: 500, json: { success: false } } : undefined],
  ['cookies lack Secure', args => args.path === '/api/auth/login' ? { status: 200, json: { success: true }, headers: { 'set-cookie': ['app_session_id=unsafe; Path=/; HttpOnly; SameSite=Lax'] } } : undefined],
  ['identity leaks credential material', args => args.cookie && args.path === '/api/trpc/auth.me'
    ? { status: 200, json: { result: { data: superjson.serialize({ id: args.cookie.includes('founder') ? 1 : 2, openId: 'fixture-worker', role: args.cookie.includes('founder') ? 'admin' : 'worker', passwordHash: 'private' }) } } } : undefined],
]) {
  test(`fails closed when ${name}`, async () => {
    const f = fixture({ response });
    await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /acceptance failed/);
    assert.equal(f.containers.size, 0); assert.equal(f.networks.size, 0); assert.equal(f.files.size, 0);
  });
}

test('requires committed epoch/audit evidence rather than trusting HTTP success', async () => {
  const f = fixture({ offboardCommitFailure: true });
  await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /offboarding/);
});

for (const options of [{ cleanupFailure: true }, { tempCleanupFailure: true }, { closeFailure: true }]) {
  test(`never returns passed when cleanup is unconfirmed: ${Object.keys(options)[0]}`, async () => {
    const f = fixture(options);
    await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /cleanup was not confirmed/);
  });
}

test('refuses to delete a resource whose ownership label changed', async () => {
  let appInspects = 0;
  const f = fixture({ command: ({ args, containers }) => {
    if (args[0] === 'container' && args[1] === 'inspect' && args[2].endsWith('-app') && containers.has(args[2])) {
      appInspects++;
      if (appInspects === 2) containers.get(args[2]).Config.Labels = { unrelated: 'another-owner' };
    }
  } });
  await assert.rejects(verifyPostgresProductionImage('candidate:test', f.dependencies), /cleanup was not confirmed/);
  assert.equal(f.commands.some(c => c.args[1] === 'rm' && String(c.args.at(-1)).endsWith('-app-id')), false);
});

test('rejects mismatched running image identity and redacts all diagnostics', async () => {
  const f = fixture({ prepareFailure: true });
  const error = await verifyPostgresProductionImage('candidate:test', f.dependencies).catch(error => error);
  assert.match(error.message, /canonical migrations/);
  assert.equal(error.message.includes(f.prepared.password), false);
  assert.equal(error.message.includes('postgresql:'), false);
  const other = fixture({ command: ({ args, containers }) => {
    if (args[0] === 'container' && args[1] === 'inspect' && containers.has(args[2]) && args[2].endsWith('-app')) {
      containers.get(args[2]).Image = PG;
    }
  } });
  await assert.rejects(verifyPostgresProductionImage('candidate:test', other.dependencies), /exact production image startup/);
});

function roleClient(overrides = {}) {
  const queries = [];
  return { queries, query: async (sql, parameters) => {
    queries.push({ sql, parameters });
    if (sql.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolreplication: false, rolinherit: false, rolbypassrls: false, ...overrides.flags }] };
    if (sql.includes('has_table_privilege')) return { rows: [{ truncate: false, ledger_insert: false,
      public_create: false, drizzle_create: false, database_create: false, temporary: false, ...overrides.privileges }] };
    return { rows: [] };
  } };
}

test('actual role configurator grants only runtime DML/sequence use and read-only ledger access', async () => {
  const client = roleClient();
  await configureApplicationRole(client, { appRole: 'synthetic_app', appPassword: 'synthetic-random-password', databaseName: 'fixture_owned' });
  const sql = client.queries.map(query => query.sql);
  assert.match(sql[0], /LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS/);
  assert.equal(sql.includes('REVOKE CREATE,TEMPORARY ON DATABASE "fixture_owned" FROM PUBLIC'), true);
  assert.equal(sql.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'), true);
  const grants = sql.filter(query => query.startsWith('GRANT'));
  assert.deepEqual(grants, [
    'GRANT CONNECT ON DATABASE "fixture_owned" TO "synthetic_app"',
    'GRANT USAGE ON SCHEMA public,drizzle TO "synthetic_app"',
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "synthetic_app"',
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "synthetic_app"',
    'GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO "synthetic_app"',
  ]);
});

for (const field of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolinherit', 'rolbypassrls']) {
  test(`actual role verifier rejects ${field}`, async () => {
    await assert.rejects(assertApplicationRolePrivileges(roleClient({ flags: { [field]: true } }), 'synthetic_app'));
  });
}
for (const field of ['truncate', 'ledger_insert', 'public_create', 'drizzle_create', 'database_create', 'temporary']) {
  test(`actual role verifier rejects unexpected ${field} privilege`, async () => {
    await assert.rejects(assertApplicationRolePrivileges(roleClient({ privileges: { [field]: true } }), 'synthetic_app'));
  });
}

test('fails closed on missing privilege/role evidence rather than accepting an empty result', async () => {
  await assert.rejects(assertApplicationRolePrivileges({ query: async () => ({ rows: [] }) }, 'synthetic_app'));
});
