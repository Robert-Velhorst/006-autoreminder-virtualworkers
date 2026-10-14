/**
 * Local authentication routes — replaces Manus OAuth for local development.
 * Provides simple username/password login and registration.
 */
import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { COOKIE_NAME, ONE_YEAR_MS } from '@shared/const';
import { sdk } from '../_core/sdk';
import { getSessionCookieOptions } from '../_core/cookies';
import * as db from '../db';
import { isLocalRegistrationAllowed } from '../_core/localRegistration';

const router = express.Router();

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

    if (password.length < 6) {
      console.log('[LocalAuth] Validation failed: password too short');
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
    console.error('[LocalAuth] Register error:', error);
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
      return res.status(401).json({ error: 'This account does not have a local password. Please use OAuth login.' });
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
    console.error('[LocalAuth] Login error:', error);
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

    const apiKey = process.env.TRELLO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Trello API key not configured' });
    }

    // Verify token with Trello API
    const response = await fetch(`https://api.trello.com/1/members/me?key=${apiKey}&token=${token}`);
    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid Trello token' });
    }

    const member = await response.json() as { id: string; username: string; fullName: string };
    const trelloId = member.id;

    const dbInstance = await db.getDb();
    if (!dbInstance) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { vaProfiles, users } = await import('../../drizzle/schema.postgres.js');
    const { eq } = await import('drizzle-orm');

    // Look up VA profile by trelloMemberId
    const matchingProfiles = await dbInstance.select().from(vaProfiles).where(eq(vaProfiles.trelloMemberId, trelloId)).limit(1);
    if (matchingProfiles.length === 0) {
      return res.status(401).json({ 
        error: `Access Denied: Trello account @${member.username} (${member.fullName}) is not registered in this system.` 
      });
    }

    const vaProfile = matchingProfiles[0];
    
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
    console.error('[LocalAuth] Trello login error:', error);
    return res.status(500).json({ error: 'Trello login failed' });
  }
});

/**
 * GET /api/auth/trello/client-key
 * Get Trello API key for client-side login.
 */
router.get('/trello/client-key', (req: Request, res: Response) => {
  const apiKey = process.env.TRELLO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Trello API key not configured' });
  }
  return res.json({ apiKey });
});

export default router;
