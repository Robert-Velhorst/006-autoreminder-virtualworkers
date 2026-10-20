/**
 * Local authentication routes — replaces Manus OAuth for local development.
 * Provides simple username/password login and registration.
 */
import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { COOKIE_NAME, ONE_YEAR_MS } from '@shared/const';
import { users, vaProfiles } from '../../drizzle/schema.postgres';
import { sdk } from '../_core/sdk';
import { getSessionCookieOptions } from '../_core/cookies';
import * as db from '../db';
import { isLocalRegistrationAllowed } from '../_core/localRegistration';
import { PASSWORD_MIN_LENGTH, validatePassword } from '../passwordPolicy';
import { selectWorkerProfile } from '../workerOperatorContext';
import { DatabaseUnavailableError, isDatabaseUnavailable, respondDatabaseUnavailable } from '../databaseAvailability';

const router = express.Router();
const TRELLO_LOGIN_REQUEST_TIMEOUT_MS = 15_000;

// A browser-issued token is tied to the API key that requested it. Keep this
// separate from the server integration key so replacing the login Power-Up
// does not invalidate the trusted background collector token.
function trelloLoginApiKey() {
  return process.env.TRELLO_LOGIN_API_KEY?.trim() || process.env.TRELLO_API_KEY?.trim() || null;
}

/**
 * Trello validates the authorization return URL before issuing a browser token.
 * Keep that URL configuration-owned in production instead of trusting a Host
 * header or whatever public origin happened to serve the login form.
 */
export function trelloLoginReturnUrl(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.TRELLO_LOGIN_RETURN_URL?.trim();
  if (explicit) {
    try {
      const parsed = new URL(explicit);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return null;
    }
    return null;
  }

  const publicBase = [
    env.PUBLIC_URL,
    env.WEBHOOK_BASE_URL,
    env.APP_URL,
    env.VITE_FRONTEND_URL,
    env.TRELLO_WEBHOOK_CALLBACK_URL,
  ].find(value => Boolean(value?.trim()));
  if (!publicBase) return null;

  try {
    const parsed = new URL(publicBase);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/trello-callback`;
  } catch {
    return null;
  }
}

function ownerBootstrapConfig() {
  return {
    openId: process.env.OWNER_BOOTSTRAP_OPEN_ID?.trim() || null,
    token: process.env.OWNER_BOOTSTRAP_TOKEN?.trim() || null,
  };
}

export function ownerBootstrapTokenMatches(expected: string, supplied: string) {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

async function getPendingOwnerBootstrap() {
  const config = ownerBootstrapConfig();
  if (!config.openId || !config.token || config.token.length < 24) return null;
  const database = await db.getDb();
  if (!database) throw new DatabaseUnavailableError();
  const [owner] = await database.select({ id: users.id, openId: users.openId, name: users.name })
    .from(users)
    .where(and(eq(users.openId, config.openId), eq(users.role, 'admin'), isNull(users.passwordHash)))
    .limit(1);
  return owner ? { ...owner, token: config.token } : null;
}

router.get('/owner-bootstrap/status', async (_req: Request, res: Response) => {
  try {
    return res.json({ available: Boolean(await getPendingOwnerBootstrap()) });
  } catch (error) {
    if (isDatabaseUnavailable(error)) return respondDatabaseUnavailable(res);
    return res.json({ available: false });
  }
});

router.post('/owner-bootstrap', async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    try {
      validatePassword(password);
    } catch {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }
    const owner = await getPendingOwnerBootstrap();
    if (!owner || !token || !ownerBootstrapTokenMatches(owner.token, token)) {
      return res.status(403).json({ error: 'Owner setup is unavailable or the setup token is invalid' });
    }
    const database = await db.getDb();
    if (!database) return respondDatabaseUnavailable(res);
    const passwordHash = await bcrypt.hash(password, 12);
    await database.update(users)
      .set({ passwordHash, loginMethod: 'local', lastSignedIn: new Date() })
      .where(and(eq(users.id, owner.id), isNull(users.passwordHash)));

    const sessionToken = await sdk.createSessionToken(owner.openId, {
      name: owner.name || owner.openId,
      expiresInMs: ONE_YEAR_MS,
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
    console.info('[LocalAuth] One-time owner access configured');
    return res.json({ success: true, message: 'Owner access configured' });
  } catch (error) {
    if (isDatabaseUnavailable(error)) return respondDatabaseUnavailable(res);
    console.error('[LocalAuth] Owner bootstrap failed');
    return res.status(500).json({ error: 'Owner setup failed' });
  }
});

/**
 * POST /api/auth/register
 * Create a new local account.
 * Body: { username, password, name }
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    if (!isLocalRegistrationAllowed()) {
      return res.status(403).json({ error: 'Public account registration is disabled.' });
    }
    console.log('[LocalAuth] Register request received:', {
      hasUsername: !!req.body?.username,
      hasPassword: !!req.body?.password,
      hasName: !!req.body?.name,
    });

    const { username, password, name } = req.body as {
      username?: string;
      password?: string;
      name?: string;
    };

    if (!username || !password) {
      console.log('[LocalAuth] Validation failed: missing username or password');
      return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
      validatePassword(password);
    } catch {
      console.log('[LocalAuth] Validation failed: password too short');
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    // Check if user already exists
    const existing = await db.getUserByOpenId(username);
    if (existing) {
      console.log('[LocalAuth] User already exists:', username);
      return res.status(409).json({ error: 'Username already taken' });
    }

    console.log('[LocalAuth] Creating new user:', username);

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user — openId = username for local auth
    await db.upsertUser({
      openId: username,
      name: name || username,
      email: null,
      loginMethod: 'local',
      lastSignedIn: new Date(),
    });

    // Store password hash
    const dbInstance = await (await import('../db')).getDb();
    if (!dbInstance) return respondDatabaseUnavailable(res);
    if (dbInstance) {
      const { users } = await import('../../drizzle/schema.postgres');
      const { eq } = await import('drizzle-orm');
      await dbInstance
        .update(users)
        .set({ passwordHash })
        .where(eq(users.openId, username));
    }

    console.log('[LocalAuth] User created successfully, creating session');

    // Create session
    const sessionToken = await sdk.createSessionToken(username, {
      name: name || username,
      expiresInMs: ONE_YEAR_MS,
    });

    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

    console.log('[LocalAuth] Registration complete');
    return res.json({ success: true, message: 'Account created successfully' });
  } catch (error) {
    if (isDatabaseUnavailable(error)) return respondDatabaseUnavailable(res);
    console.error('[LocalAuth] Registration failed');
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Log in with username and password.
 * Body: { username, password }
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user
    const user = await db.getUserByOpenId(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    if (!user.passwordHash) {
      return res.status(401).json({ error: 'This account does not have a local password. Use Sign in with Trello.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update last signed in
    await db.upsertUser({
      openId: username,
      lastSignedIn: new Date(),
    });

    // Create session
    const sessionToken = await sdk.createSessionToken(username, {
      name: user.name || username,
      expiresInMs: ONE_YEAR_MS,
    });

    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

    return res.json({ success: true, message: 'Logged in successfully' });
  } catch (error) {
    if (isDatabaseUnavailable(error)) return respondDatabaseUnavailable(res);
    console.error('[LocalAuth] Login failed');
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/trello/login-token
 * Log in using a Trello client token.
 * Body: { token }
 */
router.post('/trello/login-token', async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) {
      return res.status(400).json({ error: 'Trello token is required' });
    }

    const apiKey = trelloLoginApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Trello API key not configured' });
    }

    // Verify token with Trello API
    const response = await fetch(
      `https://api.trello.com/1/members/me?key=${apiKey}&token=${token}`,
      { signal: AbortSignal.timeout(TRELLO_LOGIN_REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid Trello token' });
    }

    const member = await response.json() as { id: string; username: string; fullName: string };
    const trelloId = member.id;

    const dbInstance = await db.getDb();
    if (!dbInstance) {
      return respondDatabaseUnavailable(res);
    }

    const { vaProfiles, users } = await import('../../drizzle/schema.postgres.js');
    const { eq } = await import('drizzle-orm');

    // Look up VA profile by trelloMemberId
    const matchingProfiles = await dbInstance.select().from(vaProfiles).where(eq(vaProfiles.trelloMemberId, trelloId))
      .orderBy(vaProfiles.id);
    if (matchingProfiles.length === 0) {
      return res.status(401).json({ 
        error: `Access Denied: Trello account @${member.username} (${member.fullName}) is not registered in this system.` 
      });
    }

    const vaProfile = selectWorkerProfile(matchingProfiles);
    if (!vaProfile || vaProfile.status !== 'active') {
      return res.status(401).json({ error: 'Access Denied: This Trello account is not uniquely linked to an active worker profile.' });
    }
    
    // Find the corresponding system user
    const matchingUsers = await dbInstance.select().from(users).where(eq(users.id, vaProfile.userId)).limit(1);
    if (matchingUsers.length === 0) {
      return res.status(401).json({ error: 'Associated system user account not found.' });
    }

    const user = matchingUsers[0];

    // Update last signed in
    await db.upsertUser({
      openId: String(user.openId),
      lastSignedIn: new Date(),
    });

    // Create session
    const sessionToken = await sdk.createSessionToken(String(user.openId), {
      name: user.name || String(user.openId),
      expiresInMs: ONE_YEAR_MS,
    });

    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

    return res.json({ success: true, message: 'Logged in successfully via Trello' });
  } catch (error) {
    if (isDatabaseUnavailable(error)) return respondDatabaseUnavailable(res);
    console.error('[LocalAuth] Trello login failed');
    return res.status(500).json({ error: 'Trello login failed' });
  }
});

/**
 * GET /api/auth/trello/client-key
 * Get Trello API key for client-side login.
 */
router.get('/trello/client-key', (req: Request, res: Response) => {
  const apiKey = trelloLoginApiKey();
  if (!apiKey) {
    return res.status(500).json({ error: 'Trello API key not configured' });
  }
  return res.json({ apiKey, returnUrl: trelloLoginReturnUrl() });
});

export default router;
