import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import superjson from 'superjson';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_LABEL = 'io.va-dashboard.postgres-image-acceptance';
const ORIGIN = 'https://acceptance.invalid';
const COOKIE = 'app_session_id';
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

function command(program, args, { timeout = 60_000 } = {}) {
  return spawnSync(program, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
}

function request({ port, path, method = 'GET', cookie, body, signal }) {
  return new Promise((resolveResponse, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method, agent: false, signal,
      headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) res.destroy(new Error('Fixture response limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolveResponse({ status: res.statusCode, headers: res.headers,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch { reject(new Error('Invalid fixture response')); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request deadline')));
    req.on('error', reject);
    req.end(payload);
  });
}

function bounded(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolveOperation, reject) => {
    const abort = () => reject(new Error('Fixture deadline or interruption'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolveOperation, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function assertApplicationRolePrivileges(client, appRole) {
  const flags = (await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=$1', [appRole])).rows[0];
  for (const field of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolinherit', 'rolbypassrls']) {
    assert.equal(flags?.[field], false);
  }
  const privileges = (await client.query(`SELECT
    has_table_privilege($1,'public.users','TRUNCATE') AS truncate,
    has_table_privilege($1,'drizzle.__drizzle_migrations','INSERT') AS ledger_insert,
    has_schema_privilege($1,'public','CREATE') AS public_create,
    has_schema_privilege($1,'drizzle','CREATE') AS drizzle_create,
    has_database_privilege($1,current_database(),'CREATE') AS database_create,
    has_database_privilege($1,current_database(),'TEMPORARY') AS temporary`, [appRole])).rows[0];
  for (const field of ['truncate', 'ledger_insert', 'public_create', 'drizzle_create', 'database_create', 'temporary']) {
    assert.equal(privileges?.[field], false);
  }
}

export async function configureApplicationRole(client, { appRole, appPassword, databaseName }) {
  const { escapeIdentifier, escapeLiteral } = await import('pg');
  const role = escapeIdentifier(appRole), database = escapeIdentifier(databaseName);
  await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS PASSWORD ${escapeLiteral(appPassword)}`);
  await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public,drizzle TO ${role}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${role}`);
  await assertApplicationRolePrivileges(client, appRole);
}

async function prepareDatabase({ url, caPath, migrationsFolder, password, fixtureId, appRole, appPassword, signal, registerClose }) {
  const { Client } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { default: bcrypt } = await import('bcryptjs');
  const makeClient = () => new Client({
    connectionString: url, ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 3000, query_timeout: 10_000, statement_timeout: 10_000,
    options: '-c search_path=public',
  });
  let client;
  const deadline = Date.now() + 30_000;
  while (true) {
    signal.throwIfAborted();
    client = makeClient();
    // Retain each client until its bounded close is confirmed, even on connect failure.
    const ownedClient = client;
    registerClose(() => ownedClient.end());
    try { await bounded(client.connect(), signal); break; }
    catch {
      await bounded(client.end(), signal);
      if (Date.now() >= deadline) throw new Error('Fixture database unavailable');
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
  }
  assert.equal(client.connection.stream.encrypted, true);
  assert.equal(client.connection.stream.authorized, true);
  assert.equal((await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl, true);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n, 0);
  await bounded(migrate(drizzle(client), { migrationsFolder }), signal);

  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  const last = journal.entries.at(-1);
  assert.match(last.tag, /^\d{4}_[a-z0-9_]+$/);
  const migrationHash = createHash('sha256').update(readFileSync(join(migrationsFolder, `${last.tag}.sql`))).digest('hex');
  const ledger = await client.query('SELECT hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1');
  assert.equal(ledger.rows[0]?.hash, migrationHash);
  assert.equal(ledger.rows[0]?.created_at, String(last.when));
  const snapshot = JSON.parse(readFileSync(join(migrationsFolder, 'meta', `${last.tag.slice(0, 4)}_snapshot.json`), 'utf8'));
  const actual = (await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")).rows;
  const expected = Object.values(snapshot.tables).flatMap(table => {
    assert.ok(!table.schema || table.schema === 'public');
    return Object.values(table.columns).map(column => ({ table_name: table.name, column_name: column.name }));
  }).sort((a, b) => a.table_name.localeCompare(b.table_name, 'en') || a.column_name.localeCompare(b.column_name, 'en'));
  const sortedActual = [...actual].sort((a, b) => a.table_name.localeCompare(b.table_name, 'en') || a.column_name.localeCompare(b.column_name, 'en'));
  assert.deepEqual(sortedActual, expected);

  const hash = await bcrypt.hash(password, 12);
  const founderOpenId = `fixture-founder-${fixtureId}`;
  const workerOpenId = `fixture-worker-${fixtureId}`;
  const insert = async (openId, role) => (await client.query(
    'INSERT INTO users ("openId",name,role,"passwordHash","loginMethod") VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [openId, 'Synthetic image fixture', role, hash, 'local'],
  )).rows[0].id;
  const founderId = await insert(founderOpenId, 'admin');
  const workerId = await insert(workerOpenId, 'worker');
  const profileId = (await client.query(
    'INSERT INTO va_profiles ("userId","founderId",name,email,status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [workerId, founderId, 'Synthetic worker', 'worker@example.invalid', 'active'],
  )).rows[0].id;
  const epoch = (await client.query('SELECT "sessionEpoch" FROM users WHERE id=$1', [workerId])).rows[0].sessionEpoch;
  assert.ok(BigInt(epoch) >= 1n);
  await configureApplicationRole(client, { appRole, appPassword, databaseName: new URL(url).pathname.slice(1) });
  return {
    founder: { id: founderId, openId: founderOpenId }, worker: { id: workerId, openId: workerOpenId }, profileId,
    schema: { tables: Object.keys(snapshot.tables).length, migration: last.tag, migrationHash },
    async verifyOffboard(applicationName) {
      const profile = (await client.query('SELECT status FROM va_profiles WHERE id=$1', [profileId])).rows[0];
      assert.equal(profile?.status, 'inactive');
      const account = (await client.query('SELECT "sessionEpoch" FROM users WHERE id=$1', [workerId])).rows[0];
      assert.ok(account && BigInt(account.sessionEpoch) > BigInt(epoch));
      assert.equal((await client.query("SELECT count(*)::int AS n FROM worker_lifecycle_audit WHERE \"userId\"=$1 AND action='offboard'", [workerId])).rows[0].n, 1);
      const connections = (await client.query('SELECT s.ssl,a.usename FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid=s.pid WHERE a.application_name=$1', [applicationName])).rows;
      assert.ok(connections.length > 0 && connections.every(row => row.ssl === true && row.usename === appRole));
      await assertApplicationRolePrivileges(client, appRole);
    },
  };
}

const defaultResources = {
  createTemp: () => mkdtempSync(join(tmpdir(), 'va-pg-image-')),
  mkdir: path => mkdirSync(path, { mode: 0o700 }),
  write: (path, value) => writeFileSync(path, value, { flag: 'wx', mode: 0o600 }),
  chmod: (path, mode) => chmodSync(path, mode),
  removeTemp: path => rmSync(path, { recursive: true, force: false }),
  prepareDatabase,
};

function sessionCookie(response) {
  assert.equal(response.status, 200);
  assert.equal(response.json?.success, true);
  const header = response.headers['set-cookie']?.find(value => value.startsWith(`${COOKIE}=`));
  assert.ok(header && /;\s*Secure(?:;|$)/i.test(header) && /;\s*HttpOnly(?:;|$)/i.test(header)
    && /;\s*SameSite=Lax(?:;|$)/i.test(header) && /;\s*Path=\/(?:;|$)/i.test(header));
  return header.split(';')[0];
}

/** No daemon, process, database or filesystem operations occur when fully injected. */
export async function verifyPostgresProductionImage(image, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  if (env.CI !== 'true' && env.POSTGRES_IMAGE_ACCEPTANCE_FIXTURE !== 'isolated-owned') {
    throw new Error('Set CI=true or POSTGRES_IMAGE_ACCEPTANCE_FIXTURE=isolated-owned before creating fixture resources.');
  }
  if ((dependencies.platform ?? process.platform) !== 'linux') throw new Error('PostgreSQL image acceptance requires Linux.');
  if (typeof image !== 'string' || !image || image.length > 512 || /[\s\x00-\x1f]/.test(image) || image.startsWith('-')) {
    throw new Error('An explicit local production image reference is required.');
  }
  if (env.DOCKER_HOST && !/^(unix:\/\/|npipe:\/\/)/.test(env.DOCKER_HOST)) throw new Error('Only a local Docker daemon is allowed.');
  const run = dependencies.run ?? command;
  const resources = { ...defaultResources, ...dependencies.resources };
  const send = dependencies.request ?? request;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolveWait => setTimeout(resolveWait, ms)));
  const fixtureId = randomUUID();
  const prefix = `va-pg-image-${fixtureId}`;
  const applicationName = `image_acceptance_${fixtureId}`;
  const tracked = [];
  const closers = [];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 180_000);
  deadline.unref();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let temp;
  let stage = 'preflight';
  let failure;
  let report;
  let diagnostic;
  const checked = (program, args, timeout) => {
    controller.signal.throwIfAborted();
    const result = run(program, args, { timeout: timeout ?? 60_000 });
    if (result.error || result.status !== 0) diagnostic = {
      operation: `${program}:${args[0]}`, commandExitCode: Number.isInteger(result.status) ? result.status : null,
      executionError: Boolean(result.error),
    };
    assert.ok(!result.error && result.status === 0);
    return result.stdout;
  };
  const inspect = (type, name) => {
    const result = run('docker', [type, 'inspect', name], { timeout: 15_000 });
    const missing = [
      `Error: No such ${type}: ${name}`,
      `Error response from daemon: No such ${type}: ${name}`,
      `Error: No such object: ${name}`,
      ...(type === 'network' ? [`Error response from daemon: network ${name} not found`] : []),
    ];
    // Docker's network API uses a different 404 message from container inspect.
    // Match the exact requested identity, never arbitrary daemon error text.
    if (!result.error && result.status === 1 &&
      ['', '[]'].includes(String(result.stdout ?? '').trim()) &&
      missing.includes(String(result.stderr ?? '').trim())) return null;
    assert.ok(!result.error && result.status === 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.length, 1);
    return value[0];
  };
  const reserve = (type, name) => {
    assert.equal(inspect(type, name), null);
    tracked.push({ type, name });
  };
  const port = (container, expectedImage, internalPort, network) => {
    const value = inspect('container', container);
    const binding = value?.NetworkSettings?.Ports?.[`${internalPort}/tcp`];
    diagnostic = {
      running: value?.State?.Running === true,
      containerExitCode: Number.isInteger(value?.State?.ExitCode) ? value.State.ExitCode : null,
      imageMatches: value?.Image === expectedImage,
      ownerMatches: value?.Config?.Labels?.[OWNER_LABEL] === fixtureId,
      networkCount: Object.keys(value?.NetworkSettings?.Networks ?? {}).length,
      publishedPortCount: Array.isArray(binding) ? binding.length : 0,
      boundToLoopback: binding?.[0]?.HostIp === '127.0.0.1',
    };
    assert.equal(value.Config.Labels[OWNER_LABEL], fixtureId);
    assert.equal(value.Image, expectedImage);
    assert.equal(value.State.Running, true);
    assert.deepEqual(Object.keys(value.NetworkSettings.Networks), [network]);
    assert.ok(Array.isArray(binding));
    assert.equal(binding.length, 1); assert.equal(binding[0].HostIp, '127.0.0.1');
    assert.match(binding[0].HostPort, /^\d{1,5}$/);
    const number = Number(binding[0].HostPort);
    assert.ok(number > 0 && number <= 65535);
    diagnostic = undefined;
    return { number, details: value };
  };
  try {
    const contexts = JSON.parse(checked('docker', ['context', 'inspect']));
    assert.ok(contexts.length === 1 && /^(unix:\/\/|npipe:\/\/)/.test(contexts[0].Endpoints.docker.Host));
    const candidate = JSON.parse(checked('docker', ['image', 'inspect', image]));
    assert.equal(candidate.length, 1);
    const imageId = candidate[0].Id;
    assert.match(imageId, imageIdPattern);
    assert.equal(candidate[0].Os, 'linux');
    assert.ok(candidate[0].Config.Env.includes('NODE_ENV=production'));
    const postgres = JSON.parse(checked('docker', ['image', 'inspect', 'postgres:18.6']));
    assert.equal(postgres.length, 1); assert.match(postgres[0].Id, imageIdPattern);
    assert.ok(postgres[0].Config.Env.includes('PG_MAJOR=18')
      && postgres[0].Config.Env.some(value => /^PG_VERSION=18\.6(?:[-.]|$)/.test(value)));

    stage = 'ephemeral TLS';
    temp = resources.createTemp();
    const tls = join(temp, 'tls'), privateDirectory = join(temp, 'private');
    resources.mkdir(tls); resources.mkdir(privateDirectory);
    const ca = join(tls, 'ca.crt'), caKey = join(privateDirectory, 'ca.key');
    const key = join(tls, 'server.key'), cert = join(tls, 'server.crt'), csr = join(privateDirectory, 'server.csr');
    const extensions = join(privateDirectory, 'extensions');
    resources.write(extensions, 'subjectAltName=DNS:fixture-postgres,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
    checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=Image acceptance CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca], 20_000);
    checked('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=fixture-postgres', '-keyout', key, '-out', csr], 20_000);
    checked('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-sha256', '-extfile', extensions, '-out', cert], 20_000);
    resources.chmod(ca, 0o644); resources.chmod(cert, 0o644); resources.chmod(key, 0o600);
    const databasePassword = randomBytes(32).toString('hex');
    const appRole = `app_${fixtureId.replaceAll('-', '')}`;
    const appPassword = randomBytes(32).toString('hex');
    const password = randomBytes(32).toString('hex');
    const database = `fixture_${fixtureId.replaceAll('-', '')}`;
    const network = `${prefix}-network`, pgName = `${prefix}-postgres`, appName = `${prefix}-app`;
    const pgEnv = join(temp, 'postgres.env');
    resources.write(pgEnv, `POSTGRES_USER=fixture\nPOSTGRES_PASSWORD=${databasePassword}\nPOSTGRES_DB=${database}\nPGDATA=/var/lib/postgresql/18/docker\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n`);
    stage = 'owned network';
    reserve('network', network);
    checked('docker', ['network', 'create', '--internal', '--label', `${OWNER_LABEL}=${fixtureId}`, network]);
    const networkDetails = inspect('network', network);
    assert.equal(networkDetails.Internal, true); assert.equal(networkDetails.Labels[OWNER_LABEL], fixtureId);
    stage = 'owned PostgreSQL';
    reserve('container', pgName);
    checked('docker', ['run', '--detach', '--pull=never', '--name', pgName, '--label', `${OWNER_LABEL}=${fixtureId}`,
      '--network', network, '--network-alias', 'fixture-postgres', '--publish', '127.0.0.1::5432', '--memory', '1g',
      '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=768m', '--tmpfs', '/run/acceptance-tls:rw,noexec,nosuid,nodev,size=4m',
      '--mount', `type=bind,source=${tls},target=/fixture-tls,readonly`, '--env-file', pgEnv,
      '--entrypoint', 'sh', postgres[0].Id, '-ec',
      'cp /fixture-tls/server.key /run/acceptance-tls/server.key; cp /fixture-tls/server.crt /run/acceptance-tls/server.crt; cp /fixture-tls/ca.crt /run/acceptance-tls/ca.crt; chown -R postgres:postgres /run/acceptance-tls; chmod 600 /run/acceptance-tls/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/acceptance-tls/server.crt -c ssl_key_file=/run/acceptance-tls/server.key -c ssl_ca_file=/run/acceptance-tls/ca.crt -c shared_buffers=32MB -c max_connections=20']);
    const published = port(pgName, postgres[0].Id, 5432, network);
    assert.ok(published.details.HostConfig.Tmpfs['/var/lib/postgresql']);
    assert.ok(!published.details.Mounts.some(mount => mount.Type === 'volume'));
    const connectionUrl = ({ host, databasePort, certificate, name = applicationName, user, secret }) => {
      const url = new URL(`postgresql://${user}:${secret}@${host}:${databasePort}/${database}`);
      url.searchParams.set('sslmode', 'verify-full'); url.searchParams.set('sslrootcert', certificate);
      url.searchParams.set('application_name', name);
      return url.href;
    };
    stage = 'canonical migrations and synthetic accounts';
    const fixture = await bounded(resources.prepareDatabase({
      url: connectionUrl({ host: '127.0.0.1', databasePort: published.number, certificate: ca,
        name: `${applicationName}_host`, user: 'fixture', secret: databasePassword }), caPath: ca,
      migrationsFolder: join(ROOT, 'drizzle-postgres-v1'), password, fixtureId, appRole, appPassword, signal: controller.signal,
      registerClose: close => closers.push(close),
    }), controller.signal);

    stage = 'exact production image startup';
    const appEnv = join(temp, 'app.env');
    const appConfiguration = {
      NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', LOCAL_AUTH_BYPASS: 'false',
      DATABASE_URL: connectionUrl({ host: 'fixture-postgres', databasePort: 5432, certificate: '/run/acceptance-ca.crt', user: appRole, secret: appPassword }),
      DATABASE_CONNECT_TIMEOUT_MS: '3000', DATABASE_POOL_MAX: '4',
      JWT_SECRET: randomBytes(48).toString('hex'), SESSION_APP_ID: 'va-dashboard',
      PUBLIC_URL: ORIGIN, APP_URL: ORIGIN, VITE_FRONTEND_URL: ORIGIN,
      TRELLO_API_KEY: randomBytes(24).toString('hex'), TRELLO_TOKEN: randomBytes(32).toString('hex'),
      BACKGROUND_JOBS_ENABLED: 'false', NOTIFICATIONS_ENABLED: 'false', BRIEFING_SCHEDULER_ENABLED: 'false',
      APTLSS_MANAGER_SCHEDULER: 'false', APTLSS_MANAGER_PROVIDER: 'codex-subscription',
      REDIS_URL: '', OAUTH_SERVER_URL: '', OPENAI_API_KEY: '', SENDGRID_API_KEY: '',
      TRELLO_WEBHOOK_CALLBACK_URL: '', TRELLO_WEBHOOK_SECRET: '', NODE_TLS_REJECT_UNAUTHORIZED: '1',
    };
    resources.write(appEnv, Object.entries(appConfiguration).map(([name, value]) => `${name}=${value}\n`).join(''));
    reserve('container', appName);
    checked('docker', ['run', '--detach', '--pull=never', '--name', appName, '--label', `${OWNER_LABEL}=${fixtureId}`,
      '--network', network, '--publish', '127.0.0.1::3000', '--memory', '512m', '--cpus', '1',
      '--mount', `type=bind,source=${ca},target=/run/acceptance-ca.crt,readonly`, '--env-file', appEnv, imageId]);
    const appPort = port(appName, imageId, 3000, network).number;
    const call = options => bounded(send({ port: appPort, signal: controller.signal, ...options }), controller.signal);
    const readyDeadline = now() + 60_000;
    while (true) {
      controller.signal.throwIfAborted();
      try {
        const ready = await call({ path: '/api/health/ready' });
        if (ready.status === 200 && ready.json?.ready === true) break;
      } catch { /* Startup can briefly refuse connections. */ }
      if (now() >= readyDeadline) throw new Error('Readiness deadline');
      await sleep(250);
    }
    const health = await call({ path: '/api/health' });
    assert.equal(health.status, 200); assert.equal(health.json?.database, 'connected');
    const live = await call({ path: '/api/health/live' });
    assert.equal(live.status, 200); assert.equal(live.json?.alive, true);
    const identity = async cookie => {
      const response = await call({ path: '/api/trpc/auth.me', cookie });
      assert.equal(response.status, 200);
      return superjson.deserialize(response.json.result.data);
    };
    assert.equal(await identity(), null);
    stage = 'password authentication and active profile';
    const login = async user => sessionCookie(await call({ path: '/api/auth/login', method: 'POST', body: { username: user.openId, password } }));
    const founderCookie = await login(fixture.founder), workerCookie = await login(fixture.worker);
    const founder = await identity(founderCookie), workerIdentity = await identity(workerCookie);
    assert.equal(founder.id, fixture.founder.id); assert.equal(founder.role, 'admin');
    assert.equal(workerIdentity.id, fixture.worker.id); assert.equal(workerIdentity.openId, fixture.worker.openId);
    assert.equal(workerIdentity.role, 'worker');
    for (const user of [founder, workerIdentity]) {
      assert.ok(!('passwordHash' in user) && !('sessionEpoch' in user));
    }
    const profile = await call({ path: '/api/va/worker/profile', cookie: workerCookie });
    assert.equal(profile.status, 200); assert.equal(profile.json.id, fixture.profileId);
    assert.equal(profile.json.userId, fixture.worker.id); assert.equal(profile.json.status, 'active');
    assert.equal((await call({ path: '/api/va/vas', cookie: workerCookie })).status, 403);
    stage = 'authenticated offboarding and stale-session rejection';
    const offboard = await call({ path: `/api/va/vas/${fixture.profileId}`, method: 'DELETE', cookie: founderCookie });
    assert.equal(offboard.status, 200); assert.equal(offboard.json?.success, true);
    await bounded(fixture.verifyOffboard(applicationName), controller.signal);
    assert.equal(await identity(workerCookie), null);
    assert.equal((await call({ path: '/api/va/worker/profile', cookie: workerCookie })).status, 401);
    assert.equal((await call({ path: '/api/auth/login', method: 'POST', body: { username: fixture.worker.openId, password } })).status, 403);
    assert.equal((await identity(founderCookie)).id, fixture.founder.id);
    report = { passed: true, imageId, postgresImageId: postgres[0].Id,
      scope: 'isolated-configured-postgres-production-image', providerAcceptance: false,
      ...fixture.schema, checks: ['verified-postgres-tls-host-and-app', 'least-privilege-app-role', 'canonical-schema', 'readiness',
        'password-login', 'safe-auth-me', 'active-worker-profile', 'worker-admin-denial', 'offboard-epoch', 'stale-session-denial'] };
  } catch {
    failure = new Error(`PostgreSQL image acceptance failed at ${stage}. No production acceptance is established.` +
      (diagnostic ? ` Diagnostic: ${JSON.stringify(diagnostic)}` : ''));
  } finally {
    clearTimeout(deadline);
    let cleanupFailed = false;
    for (const close of closers.reverse()) {
      let timer;
      try {
        await Promise.race([Promise.resolve().then(close), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Close deadline')), 5000); })]);
      } catch { cleanupFailed = true; }
      finally { clearTimeout(timer); }
    }
    for (const resource of tracked.reverse()) {
      try {
        const value = inspect(resource.type, resource.name);
        if (!value) continue;
        const labels = resource.type === 'container' ? value.Config.Labels : value.Labels;
        assert.equal(labels?.[OWNER_LABEL], fixtureId);
        assert.ok(typeof value.Id === 'string' && value.Id.length > 0);
        const args = resource.type === 'container' ? ['container', 'rm', '--force', '--volumes', value.Id] : ['network', 'rm', value.Id];
        const removed = run('docker', args, { timeout: 30_000 });
        assert.ok(!removed.error && removed.status === 0);
        assert.equal(inspect(resource.type, resource.name), null);
      } catch { cleanupFailed = true; }
    }
    if (temp) {
      try { resources.removeTemp(temp); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) failure = new Error('PostgreSQL image acceptance incomplete: owned-resource cleanup was not confirmed.');
    else if (controller.signal.aborted) failure = new Error('PostgreSQL image acceptance interrupted or exceeded its deadline.');
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) throw failure;
  return { ...report, cleanupConfirmed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await verifyPostgresProductionImage(process.argv[2]))); }
  catch (error) { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; }
}
