import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';

const redis = vi.hoisted(() => ({
  pub: null as ReturnType<typeof redisClient> | null,
  sub: null as ReturnType<typeof redisClient> | null,
  ready: false,
}));
const auth = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('./_core/sdk', () => ({ sdk: { authenticateRequest: auth.authenticate } }));
vi.mock('./db', () => ({ getDb: vi.fn() }));
vi.mock('./services/redis', () => ({
  getRedisPubClient: () => redis.pub,
  getRedisSubClient: () => redis.sub,
  isRedisAvailable: () => redis.ready,
}));
import { WebSocketService } from './services/websocket';

// Exercise the real adapter's server-side protocol, without Redis or providers.
const subscribers = new Set<EventEmitter & { channels: Set<string>; patterns: Set<string> }>();
function redisClient() {
  const client = Object.assign(new EventEmitter(), {
    status: 'ready', channels: new Set<string>(), patterns: new Set<string>(),
    publish: vi.fn(async (channel: string, message: string | Buffer) => {
      for (const subscriber of subscribers) {
        if (subscriber.channels.has(channel)) {
          subscriber.emit('messageBuffer', Buffer.from(channel), Buffer.from(message));
        }
        for (const pattern of subscriber.patterns) {
          if (channel.startsWith(pattern.slice(0, -1))) {
            subscriber.emit('pmessageBuffer', Buffer.from(pattern), Buffer.from(channel), Buffer.from(message));
          }
        }
      }
      return subscribers.size;
    }),
    psubscribe: vi.fn(async (pattern: string) => {
      client.patterns.add(pattern); subscribers.add(client); return 1;
    }),
    subscribe: vi.fn(async (channels: string[]) => {
      for (const channel of channels) client.channels.add(channel);
      subscribers.add(client);
      return 1;
    }),
    punsubscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => { subscribers.delete(client); return 1; }),
  });
  return client;
}

type User = { id: number; openId: string; name: string; role: 'worker' | 'admin' };
const worker: User = { id: 1, openId: 'worker-1', name: 'Worker', role: 'worker' };
const identities = new Map<string, User>();
const revoked = new Set<string>();
const offboarded = new Set<string>();
const owners = new Map<string, string>();
let databaseDown = false;
let authGate: (() => Promise<void>) | undefined;
let sessionGate: (() => Promise<void>) | undefined;
let sessionDatabaseDown = false;
const clients: Socket[] = [];
const nodes: Array<{ service: WebSocketService; server: ReturnType<typeof createServer>; pub: ReturnType<typeof redisClient> | null }> = [];

function event<T = unknown>(client: Socket, name: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture event deadline: ${name}`)), 2000);
    client.once(name, value => { clearTimeout(timeout); resolve(value); });
  });
}
async function startNode(cluster = false) {
  redis.ready = cluster;
  redis.pub = cluster ? redisClient() : null;
  redis.sub = cluster ? redisClient() : null;
  const server = createServer();
  const service = new WebSocketService({
    authorizeSession: async (user, sessionId) => {
      await sessionGate?.();
      if (sessionDatabaseDown) throw new Error('Fixture private ownership failure');
      return owners.get(sessionId) === user.openId;
    },
  });
  service.initialize(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const node = { service, server, pub: redis.pub, sub: redis.sub };
  nodes.push(node);
  return node;
}
async function connect(node: typeof nodes[number], token: string, user = worker) {
  identities.set(token, { ...user });
  const address = node.server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server not bound');
  const client = io(`http://127.0.0.1:${address.port}`, {
    path: '/ws', transports: ['websocket'], reconnection: false, autoConnect: false,
    extraHeaders: { Cookie: `session=${token}` },
  });
  clients.push(client);
  const authenticated = event(client, 'authenticated');
  client.connect();
  await authenticated;
  return client;
}
async function join(client: Socket) {
  const joined = event(client, 'session-joined');
  client.emit('join-session', 'session-1');
  await joined;
}
function invalidate(reason: string, token: string) {
  if (reason === 'logout') revoked.add(token);
  if (reason === 'offboard') offboarded.add(identities.get(token)!.openId);
  if (reason === 'database failure') databaseDown = true;
}
const pause = () => new Promise(resolve => setTimeout(resolve, 30));

beforeEach(() => {
  identities.clear(); revoked.clear(); offboarded.clear(); owners.clear(); subscribers.clear();
  owners.set('session-1', worker.openId);
  databaseDown = false; authGate = undefined;
  sessionGate = undefined; sessionDatabaseDown = false;
  redis.pub = redis.sub = null; redis.ready = false;
  auth.authenticate.mockReset();
  auth.authenticate.mockImplementation(async (request: { headers: { cookie?: string } }) => {
    const token = request.headers.cookie?.replace('session=', '') ?? '';
    await authGate?.();
    const user = identities.get(token);
    if (databaseDown || revoked.has(token) || !user || offboarded.has(user.openId)) {
      throw new Error('Fixture private authentication failure');
    }
    return user;
  });
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const node of nodes.splice(0)) {
    await new Promise<void>(resolve => node.service.getIO()!.close(() => resolve()));
  }
  subscribers.clear();
});

describe('connected WebSocket session revocation', () => {
  for (const reason of ['logout', 'offboard', 'database failure']) {
    it.each(['task:complete', 'task:reschedule', 'cache:invalidate', 'join-session', 'leave-session'])(
      `rejects inbound %s after ${reason}`, async inbound => {
        const node = await startNode();
        const sender = await connect(node, 'sender');
        const receiver = await connect(node, 'receiver');
        await join(sender);
        const received = vi.fn();
        receiver.onAny(received);
        sender.on('session-joined', received);
        const disconnected = event(sender, 'disconnect');
        invalidate(reason, 'sender');
        sender.emit(inbound, inbound.endsWith('session') ? 'session-1' : { taskId: 'private' });
        await disconnected; await pause();
        expect(received).not.toHaveBeenCalled();
        expect(node.service.getConnectedClientsCount()).toBe(1);
      },
    );

    it.each(['user', 'session', 'all'] as const)(`withholds outbound %s after ${reason}`, async target => {
      const node = await startNode();
      const client = await connect(node, 'revoked');
      await join(client);
      const received = vi.fn(); client.on('sensitive', received);
      const disconnected = event(client, 'disconnect');
      invalidate(reason, 'revoked');
      if (target === 'user') node.service.emitToUser(worker.openId, 'sensitive', { private: true });
      if (target === 'session') node.service.emitToSession('session-1', 'sensitive', { private: true });
      if (target === 'all') node.service.emitToAll('sensitive', { private: true });
      await disconnected; await pause();
      expect(received).not.toHaveBeenCalled();
      expect(node.service.getConnectedClientsCount()).toBe(0);
    });
  }

  it.each([
    { id: 2 }, { openId: 'another-worker' }, { role: 'admin' as const },
  ])('disconnects instead of refreshing original claims: %j', async change => {
    const node = await startNode();
    const client = await connect(node, 'original');
    const received = vi.fn(); client.on('sensitive', received);
    const disconnected = event(client, 'disconnect');
    Object.assign(identities.get('original')!, change);
    node.service.emitToAll('sensitive', 'private');
    await disconnected;
    expect(received).not.toHaveBeenCalled();
  });

  it('cannot replace a logged-out original session with another valid session for the same worker', async () => {
    const node = await startNode();
    const old = await connect(node, 'old');
    const fresh = await connect(node, 'fresh');
    revoked.add('old');
    const disconnected = event(old, 'disconnect');
    const received = event(fresh, 'sensitive');
    node.service.emitToUser(worker.openId, 'sensitive', 'valid-session-only');
    await disconnected;
    await expect(received).resolves.toBe('valid-session-only');
    expect(node.service.getUserClientsCount(worker.openId)).toBe(1);
  });

  it('rechecks session ownership for existing room members on every outbound session event', async () => {
    const node = await startNode();
    const previousOwner = await connect(node, 'previous-owner');
    const newOwner = await connect(node, 'new-owner', { ...worker, id: 2, openId: 'worker-2' });
    await join(previousOwner);
    owners.set('session-1', 'worker-2');
    await join(newOwner);
    const leaked = vi.fn(); previousOwner.on('sensitive', leaked);
    const received = event(newOwner, 'sensitive');
    node.service.emitToSession('session-1', 'sensitive', 'new-owner-only');
    await expect(received).resolves.toBe('new-owner-only');
    await pause();
    expect(leaked).not.toHaveBeenCalled();
  });

  it('withholds a delivery when revocation occurs during the asynchronous authentication check', async () => {
    const node = await startNode();
    const client = await connect(node, 'pending');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    authGate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const received = vi.fn(); client.on('sensitive', received);
    const disconnected = event(client, 'disconnect');
    node.service.emitToUser(worker.openId, 'sensitive', 'private');
    await started;
    revoked.add('pending'); release();
    await disconnected;
    expect(received).not.toHaveBeenCalled();
  });

  it('fails closed when session ownership cannot be checked for a connected recipient', async () => {
    const node = await startNode();
    const client = await connect(node, 'session-owner');
    await join(client);
    const received = vi.fn(); client.on('sensitive', received);
    const disconnected = event(client, 'disconnect');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      sessionDatabaseDown = true;
      node.service.emitToSession('session-1', 'sensitive', 'private');
      await disconnected;
      expect(received).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat().join(' ')).not.toContain('Fixture private');
    } finally { warning.mockRestore(); }
  });

  it.each(['logout', 'leave'])('rechecks the recipient after pending ownership authorization: %s', async action => {
    const node = await startNode();
    const client = await connect(node, 'pending-owner');
    await join(client);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    sessionGate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const received = vi.fn(); client.on('sensitive', received);
    node.service.emitToSession('session-1', 'sensitive', 'private');
    await started;
    if (action === 'logout') {
      const disconnected = event(client, 'disconnect');
      revoked.add('pending-owner'); release();
      await disconnected;
    } else {
      client.emit('leave-session', 'session-1');
      await vi.waitFor(() => expect(node.service.getIO()!.sockets.sockets.get(client.id!)!.rooms.has('session:session-1')).toBe(false));
      release(); await pause();
    }
    expect(received).not.toHaveBeenCalled();
  });
});

describe('cross-node guarded recipient fanout', () => {
  for (const reason of ['logout', 'offboard', 'database failure']) {
  it.each(['user', 'session', 'all'] as const)(`reauthenticates remote %s recipients after ${reason} through the real adapter protocol`, async target => {
    const source = await startNode(true), remote = await startNode(true);
    const stale = await connect(remote, 'stale');
    const valid = await connect(remote, 'valid', reason === 'offboard'
      ? { ...worker, id: 2, openId: 'worker-2' } : worker);
    await join(stale);
    if (reason !== 'offboard') await join(valid);
    invalidate(reason, 'stale');
    const leaked = vi.fn(); stale.on('sensitive', leaked);
    const disconnected = event(stale, 'disconnect');
    const received = vi.fn(); valid.on('sensitive', received);
    if (target === 'user') source.service.emitToUser(worker.openId, 'sensitive', 'guarded');
    if (target === 'session') source.service.emitToSession('session-1', 'sensitive', 'guarded');
    if (target === 'all') source.service.emitToAll('sensitive', 'guarded');
    await disconnected;
    await pause();
    if (reason === 'logout' || (reason === 'offboard' && target === 'all')) {
      expect(received).toHaveBeenCalledWith('guarded');
    } else {
      expect(received).not.toHaveBeenCalled();
    }
    expect(leaked).not.toHaveBeenCalled();
    expect(source.pub!.publish).toHaveBeenCalledOnce();
    const [channel, payload] = source.pub!.publish.mock.calls[0];
    expect(channel).toBe('socket.io-request#/_guarded-delivery#');
    expect(JSON.parse(String(payload))).toMatchObject({ type: 6, data: ['guarded-delivery:v1', { target }] });
    expect(remote.pub!.publish).not.toHaveBeenCalled();
  });
  }

  it('isolates legacy unchecked Redis room broadcasts from client sockets', async () => {
    const source = await startNode(true), remote = await startNode(true);
    const stale = await connect(remote, 'legacy-recipient');
    const valid = await connect(remote, 'valid-recipient');
    const leaked = vi.fn(); stale.on('sensitive', leaked); valid.on('sensitive', leaked);
    revoked.add('legacy-recipient');
    // Simulate an older node still publishing raw room packets on the default namespace.
    source.service.getIO()!.sockets.adapter = createAdapter(source.pub, source.sub)(source.service.getIO()!.sockets);
    source.service.getIO()!.to(`user:${worker.openId}`).emit('sensitive', 'unchecked');
    await pause();
    expect(leaked).not.toHaveBeenCalled();
    expect(stale.connected).toBe(true);
    const disconnected = event(stale, 'disconnect');
    const received = event(valid, 'guarded');
    source.service.emitToUser(worker.openId, 'guarded', 'checked');
    await disconnected;
    await expect(received).resolves.toBe('checked');
  });

  it('rejects clients attempting to join the server-only delivery namespace', async () => {
    const node = await startNode(true);
    const address = node.server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server not bound');
    const client = io(`http://127.0.0.1:${address.port}/_guarded-delivery`, {
      path: '/ws', transports: ['websocket'], reconnection: false, autoConnect: false,
    });
    clients.push(client);
    const rejected = event(client, 'connect_error');
    client.connect();
    await expect(rejected).resolves.toMatchObject({ message: 'Server-only namespace' });
    expect(node.service.getConnectedClientsCount()).toBe(0);
  });

  it.each([
    ['task:complete', 'task:completed'], ['task:reschedule', 'task:rescheduled'], ['cache:invalidate', 'cache:invalidated'],
  ])('checks remote recipients for the %s relay', async (inbound, outbound) => {
    const source = await startNode(true), remote = await startNode(true);
    const sender = await connect(source, 'sender');
    const stale = await connect(remote, 'stale');
    const valid = await connect(remote, 'valid');
    revoked.add('stale');
    const leaked = vi.fn(); stale.on(outbound, leaked); sender.on(outbound, leaked);
    const disconnected = event(stale, 'disconnect');
    const received = event(valid, outbound);
    sender.emit(inbound, { taskId: 'task-1' });
    await disconnected;
    await expect(received).resolves.toMatchObject({ timestamp: expect.any(String) });
    expect(leaked).not.toHaveBeenCalled();
  });
});
